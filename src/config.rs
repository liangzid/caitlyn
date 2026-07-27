use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::error::{CaitlynError, CaitlynResult};

/// Top-level CAITLYN configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaitlynConfig {
    pub daemon: DaemonConfig,
    pub llm: LlmConfig,
    pub scanning: ScanningConfig,
    pub vaccination: VaccinationConfig,
    pub memory: MemoryConfig,
    pub storage: StorageConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonConfig {
    pub http_port: u16,
    pub mcp_mode: McpMode,
    // TODO: gRPC port for future gRPC server support
    // pub grpc_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpMode {
    Stdio,
    Sse,
    Off,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub provider: String,
    pub model: String,
    pub api_key_env: String,
    pub base_url: String,
    pub small_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ScanningConfig {
    pub max_parallel_tier1: usize,
    pub max_parallel_tier2: usize,
    pub tier1_timeout_ms: u64,
    pub tier2_timeout_ms: u64,
    pub tier3_timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaccinationConfig {
    /// Minimum encounters before triggering vaccination
    pub min_samples: u64,
    /// Must be correctly detecting attacks at this rate
    pub min_success_rate: f64,
    /// Trigger if average latency exceeds this (microseconds)
    pub latency_threshold_us: u64,
    /// Trigger if average token cost exceeds this
    pub token_threshold: u64,
    /// Number of SHM variants to generate
    pub shm_variants: usize,
    /// Base temperature for SHM mutations
    pub shm_base_temperature: f64,
    /// Maximum survivors from affinity maturation
    pub max_survivors: usize,
    /// Weight for recall in affinity scoring
    pub affinity_recall_weight: f64,
    /// Maximum tolerable false positive rate
    pub fp_tolerance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryConfig {
    pub fts5_enabled: bool,
    pub semantic_enabled: bool,
    pub max_entries: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageConfig {
    pub db_path: String,
    pub antibody_dir: String,
    pub valset_dir: String,
}

impl Default for CaitlynConfig {
    fn default() -> Self {
        Self {
            daemon: DaemonConfig {
                http_port: 9070,
                mcp_mode: McpMode::Off,
            },
            llm: LlmConfig {
                provider: "deepseek".into(),
                model: "deepseek-chat".into(),
                api_key_env: "DEEPSEEK_API_KEY".into(),
                base_url: "https://api.deepseek.com".into(),
                small_model: "deepseek-chat".into(),
            },
            scanning: ScanningConfig {
                max_parallel_tier1: 10,
                max_parallel_tier2: 5,
                tier1_timeout_ms: 500,
                tier2_timeout_ms: 3000,
                tier3_timeout_ms: 15000,
            },
            vaccination: VaccinationConfig {
                min_samples: 5,
                min_success_rate: 0.7,
                latency_threshold_us: 2_000_000, // 2 seconds
                token_threshold: 4000,
                shm_variants: 10,
                shm_base_temperature: 0.8,
                max_survivors: 3,
                affinity_recall_weight: 0.7,
                fp_tolerance: 0.05,
            },
            memory: MemoryConfig {
                fts5_enabled: true,
                semantic_enabled: false,
                max_entries: 100_000,
            },
            storage: StorageConfig {
                db_path: "./caitlyn.db".into(),
                antibody_dir: "./antibodies".into(),
                valset_dir: "./valsets".into(),
            },
        }
    }
}

impl CaitlynConfig {
    /// Load configuration from a TOML file, merging with defaults.
    pub fn load(path: Option<&str>) -> CaitlynResult<Self> {
        let path = path.unwrap_or("config.toml");
        let path = PathBuf::from(path);

        let mut config = Self::default();

        if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            let file_config: CaitlynConfig = toml::from_str(&content)
                .map_err(|e| CaitlynError::Config(format!("Failed to parse config: {e}")))?;
            config.merge(file_config);
        }

        // Override from environment variables
        config.apply_env_overrides();

        Ok(config)
    }

    fn merge(&mut self, other: Self) {

        // LLM config
        self.llm.provider = other.llm.provider;
        self.llm.model = other.llm.model;
        self.llm.api_key_env = other.llm.api_key_env;
        self.llm.base_url = other.llm.base_url;
        self.llm.small_model = other.llm.small_model;

        // Scanning config
        self.scanning.max_parallel_tier1 = other.scanning.max_parallel_tier1;
        self.scanning.max_parallel_tier2 = other.scanning.max_parallel_tier2;
        self.scanning.tier1_timeout_ms = other.scanning.tier1_timeout_ms;
        self.scanning.tier2_timeout_ms = other.scanning.tier2_timeout_ms;
        self.scanning.tier3_timeout_ms = other.scanning.tier3_timeout_ms;

        // Vaccination config
        self.vaccination.min_samples = other.vaccination.min_samples;
        self.vaccination.min_success_rate = other.vaccination.min_success_rate;
        self.vaccination.latency_threshold_us = other.vaccination.latency_threshold_us;
        self.vaccination.token_threshold = other.vaccination.token_threshold;
        self.vaccination.shm_variants = other.vaccination.shm_variants;
        self.vaccination.shm_base_temperature = other.vaccination.shm_base_temperature;
        self.vaccination.max_survivors = other.vaccination.max_survivors;
        self.vaccination.affinity_recall_weight = other.vaccination.affinity_recall_weight;
        self.vaccination.fp_tolerance = other.vaccination.fp_tolerance;

        // Memory config
        self.memory.fts5_enabled = other.memory.fts5_enabled;
        self.memory.semantic_enabled = other.memory.semantic_enabled;
        self.memory.max_entries = other.memory.max_entries;

        // Storage config
        self.storage.db_path = other.storage.db_path;
        self.storage.antibody_dir = other.storage.antibody_dir;
        self.storage.valset_dir = other.storage.valset_dir;

        // Daemon config
        self.daemon.http_port = other.daemon.http_port;
        self.daemon.mcp_mode = other.daemon.mcp_mode;
    }

    fn apply_env_overrides(&mut self) {
        if let Ok(val) = std::env::var("CAITLYN_HTTP_PORT") {
            if let Ok(p) = val.parse() {
                self.daemon.http_port = p;
            }
        }
        if let Ok(val) = std::env::var("CAITLYN_MCP_MODE") {
            self.daemon.mcp_mode = match val.as_str() {
                "stdio" => McpMode::Stdio,
                "sse" => McpMode::Sse,
                _ => McpMode::Off,
            };
        }
        if let Ok(val) = std::env::var("CAITLYN_DB_PATH") {
            self.storage.db_path = val;
        }
    }
}
