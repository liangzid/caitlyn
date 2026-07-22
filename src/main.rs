//! CAITLYN daemon entry point.
//!
//! Starts the CAITLYN daemon with HTTP API and optional MCP server.

use std::sync::Arc;
use clap::Parser;
use tracing::info;
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

    let llm: Arc<dyn caitlyn::llm::LlmProvider> = Arc::new(
        DeepSeekProvider::from_env_defaults()?
    );

    let status = caitlyn.status().await;
    info!(
        "CAITLYN ready: {} active antibodies, {} memory entries",
        status.active_antibodies, status.memory_entries
    );

    // Route based on MCP mode
    match config.daemon.mcp_mode {
        caitlyn::config::McpMode::Stdio => {
            info!("Starting in MCP stdio mode");
            caitlyn::server::serve_mcp(Arc::clone(&caitlyn)).await?;
        }
        _ => {
            // Default: HTTP server
            let port = config.daemon.http_port;
            info!("Starting HTTP server on port {}", port);
            caitlyn::server::serve_http(Arc::clone(&caitlyn), Arc::clone(&llm), port).await?;
        }
    }

    info!("Shutting down...");

    Ok(())
}
