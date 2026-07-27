//! CAITLYN daemon entry point.
//!
//! Starts the CAITLYN daemon with HTTP API and optional MCP server.

use std::sync::Arc;
use clap::Parser;
use tokio::signal;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use caitlyn::config::CaitlynConfig;
use caitlyn::llm::DeepSeekProvider;
use caitlyn::Caitlyn;

#[derive(Parser)]
#[command(name = "caitlynd", about = "CAITLYN defense daemon")]
struct Cli {
    /// Path to config file
    #[arg(short, long, default_value = "config.toml")]
    config: String,

    /// HTTP listen port (overrides config)
    #[arg(long)]
    port: Option<u16>,

    /// MCP mode: stdio, sse, or off
    #[arg(long)]
    mcp: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    info!("CAITLYN daemon starting...");

    // Load configuration
    let mut config = CaitlynConfig::load(Some(&cli.config))?;
    if let Some(port) = cli.port {
        config.daemon.http_port = port;
    }
    if let Some(mcp) = cli.mcp {
        config.daemon.mcp_mode = match mcp.as_str() {
            "stdio" => caitlyn::config::McpMode::Stdio,
            "sse" => caitlyn::config::McpMode::Sse,
            _ => caitlyn::config::McpMode::Off,
        };
    }

    let caitlyn = Caitlyn::new(config.clone()).await?;
    let caitlyn = std::sync::Arc::new(caitlyn);

    let llm: Arc<dyn caitlyn::llm::LlmProvider> = {
        let provider = config.llm.provider.to_lowercase();
        match provider.as_str() {
            "deepseek" | "openrouter" => Arc::new(DeepSeekProvider::from_env(
                &config.llm.api_key_env,
                &config.llm.base_url,
                &config.llm.model,
            )?),
            other => {
                warn!(
                    "Unknown LLM provider '{}', falling back to DeepSeek",
                    other
                );
                Arc::new(DeepSeekProvider::from_env(
                    &config.llm.api_key_env,
                    &config.llm.base_url,
                    &config.llm.model,
                )?)
            }
        }
    };

    let status = caitlyn.status().await;
    info!(
        "CAITLYN ready: {} active antibodies, {} memory entries",
        status.active_antibodies, status.memory_entries
    );


    // Race the server against shutdown signals
    tokio::select! {
        result = async {
            match config.daemon.mcp_mode {
                caitlyn::config::McpMode::Stdio => {
                    info!("Starting in MCP stdio mode");
                    caitlyn::server::serve_mcp(Arc::clone(&caitlyn), Arc::clone(&llm)).await
                }
                _ => {
                    let port = config.daemon.http_port;
                    info!("Starting HTTP server on port {}", port);
                    caitlyn::server::serve_http(Arc::clone(&caitlyn), Arc::clone(&llm), port).await
                }
            }
        } => { result?; }

        _ = shutdown_signal() => {
            warn!("Received shutdown signal, initiating graceful shutdown...");
            if let Err(e) = caitlyn.prune().await {
                warn!("Error during prune: {e}");
            }
            info!("Shutting down, draining in-flight requests...");
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            info!("Shutdown complete.");
        }
    }

    Ok(())
}

/// Wait for SIGINT (Ctrl+C) or SIGTERM.
async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
