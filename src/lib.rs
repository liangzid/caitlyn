//! CAITLYN: Continuous Agents for Injection Threats via Lifelong Yielding Nexus
//!
//! An agentic, evolvable defense system for LLM agents.
//! CAITLYN acts as a continuously-monitoring daemon that scans external content
//! before it enters an agent's context, detecting injection, poisoning,
//! jailbreak, and exfiltration attacks.
//!
//! When defense against a recurring attack pattern is too expensive
//! (high latency or token cost), CAITLYN triggers "vaccination" — evolving
//! a lightweight, specialized antibody that handles the pattern efficiently.

pub mod config;
pub mod core;
pub mod error;
pub mod evolution;
pub mod llm;
pub mod server;
pub mod storage;
pub mod surveillance;

use std::sync::Arc;
use sqlx::SqlitePool;
use tracing::info;

use crate::config::CaitlynConfig;
use crate::core::{AntibodyPool, MemoryBank};
use crate::error::CaitlynResult;
use crate::surveillance::cost_monitor::CostMonitor;
use crate::surveillance::scanner::SurveillanceScanner;
/// The main CAITLYN engine.
pub struct Caitlyn {
    pub config: CaitlynConfig,
    pub antibody_pool: Arc<AntibodyPool>,
    pub memory_bank: Arc<MemoryBank>,
    pub cost_monitor: Arc<CostMonitor>,
    pub scanner: SurveillanceScanner,
    pub db: Option<SqlitePool>,
}

impl Caitlyn {
    /// Create a new CAITLYN instance from configuration.
    pub async fn new(config: CaitlynConfig) -> CaitlynResult<Self> {
        info!("Initializing CAITLYN v{}", env!("CARGO_PKG_VERSION"));

        // Initialize storage
        let db = storage::db::init_db(&config.storage).await?;

        // Initialize antibody pool
        let antibody_pool = Arc::new(AntibodyPool::new());

        // Load builtin antibodies
        let antibodies = storage::antibody_store::load_antibodies(&config.storage.antibody_dir).await?;
        for ab in antibodies {
            antibody_pool.add(ab).await?;
        }
        info!("Antibody pool: {} antibodies loaded", antibody_pool.len().await);

        // Initialize memory bank
        let memory_bank = Arc::new(MemoryBank::new());

        // Load memory entries from DB
        let memory_entries = storage::db::load_memory_entries(&db).await?;
        for entry in memory_entries {
            memory_bank.add(entry).await?;
        }
        info!("Memory bank: {} entries loaded", memory_bank.len().await);

        // Initialize cost monitor
        let cost_monitor = Arc::new(CostMonitor::new(config.vaccination.clone()));
        // Initialize surveillance scanner
        let scanner = SurveillanceScanner::new(config.scanning.clone());

        Ok(Self {
            config,
            antibody_pool,
            memory_bank,
            cost_monitor,
            scanner,
            db: Some(db),
        })
    }

    /// Scan external content for attacks.
    ///
    /// This is the main entry point for defense. It runs the multi-tier
    /// surveillance loop: memory fast-path → specialized antibodies →
    /// general antibodies → deep analysis.
    pub async fn scan(
        &self,
        content: &str,
        context: &core::ScanContext,
        llm: Arc<dyn crate::llm::LlmProvider>,
    ) -> CaitlynResult<core::ScanResult> {
        self.scanner
            .scan(
                content,
                context,
                &self.antibody_pool,
                &self.memory_bank,
                &self.cost_monitor,
                llm,
            )
            .await
    }

    /// Manually trigger vaccination for a specific pattern.
    pub async fn vaccinate(&self, _pattern_hash: &str) -> CaitlynResult<()> {
        // TODO: Phase 3 implementation
        Ok(())
    }

    /// Run immune tolerance pruning.
    pub async fn prune(&self) -> CaitlynResult<()> {
        self.memory_bank
            .prune(self.config.memory.max_entries)
            .await;
        // TODO: Prune low-affinity antibodies
        Ok(())
    }

    /// Get daemon status.
    pub async fn status(&self) -> CaitlynStatus {
        let pool_counts = self.antibody_pool.count_by_status().await;
        CaitlynStatus {
            version: env!("CARGO_PKG_VERSION").to_string(),
            active_antibodies: pool_counts
                .get(&core::AntibodyStatus::Active)
                .copied()
                .unwrap_or(0),
            memory_entries: self.memory_bank.len().await,
            tracked_patterns: self.cost_monitor.pattern_count().await,
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub struct CaitlynStatus {
    pub version: String,
    pub active_antibodies: usize,
    pub memory_entries: usize,
    pub tracked_patterns: usize,
}
