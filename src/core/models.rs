use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Defense tier determines cost and capability of an antibody.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum DefenseTier {
    /// Tier 0: Memory fast-path (microseconds) — signature matching only
    Signature = 0,
    /// Tier 1: Specialized antibody — single cheap LLM call, no tools (~100ms)
    Specialized = 1,
    /// Tier 2: General antibody — full LLM call with optional tools (~500ms)
    General = 2,
    /// Tier 3: Deep analysis — multi-step LLM with tool calls (~2-5s)
    Deep = 3,
}

impl std::fmt::Display for DefenseTier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DefenseTier::Signature => write!(f, "signature"),
            DefenseTier::Specialized => write!(f, "specialized"),
            DefenseTier::General => write!(f, "general"),
            DefenseTier::Deep => write!(f, "deep"),
        }
    }
}

/// Categories of attacks that antibodies target.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AttackCategory {
    #[serde(rename = "injection")]
    Injection,
    #[serde(rename = "poisoning")]
    Poisoning,
    #[serde(rename = "jailbreak")]
    Jailbreak,
    #[serde(rename = "exfil")]
    DataExfiltration,
    #[serde(rename = "tool_misuse")]
    ToolMisuse,
    #[serde(rename = "unknown")]
    Unknown,
}

impl std::fmt::Display for AttackCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AttackCategory::Injection => write!(f, "injection"),
            AttackCategory::Poisoning => write!(f, "poisoning"),
            AttackCategory::Jailbreak => write!(f, "jailbreak"),
            AttackCategory::DataExfiltration => write!(f, "exfil"),
            AttackCategory::ToolMisuse => write!(f, "tool_misuse"),
            AttackCategory::Unknown => write!(f, "unknown"),
        }
    }
}

/// Status of an antibody in the pool.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
pub enum AntibodyStatus {
    #[default]
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "suppressed")]
    Suppressed,
    #[serde(rename = "retired")]
    Retired,
    #[serde(rename = "candidate")]
    Candidate,
}
/// A signature for fast-path memory matching.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Signature {
    pub pattern: String,
    #[serde(rename = "type")]
    pub sig_type: SignatureType,
    /// Optional human-readable label for tracing/logging
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SignatureType {
    #[serde(rename = "exact")]
    Exact,
    #[serde(rename = "regex")]
    Regex,
    #[serde(rename = "semantic")]
    Semantic,
}

/// Performance statistics for an antibody.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AntibodyStats {
    pub true_positives: u64,
    pub false_positives: u64,
    pub true_negatives: u64,
    pub false_negatives: u64,
    pub total_scans: u64,
    /// Average latency in microseconds (internally f64 for EMA precision)
    pub avg_latency_us: f64,
    /// Average token cost per scan (internally f64 for EMA precision)
    pub avg_tokens: f64,
}

impl AntibodyStats {
    pub fn precision(&self) -> f64 {
        let denom = self.true_positives + self.false_positives;
        if denom == 0 {
            0.0
        } else {
            self.true_positives as f64 / denom as f64
        }
    }

    pub fn recall(&self) -> f64 {
        let denom = self.true_positives + self.false_negatives;
        if denom == 0 {
            0.0
        } else {
            self.true_positives as f64 / denom as f64
        }
    }
}

/// A single defense skill — the unit of evolution in CAITLYN.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Antibody {
    pub id: String,
    pub name: String,
    pub description: String,
    /// System prompt used for LLM-based scanning
    pub prompt: String,
    pub category: AttackCategory,
    pub tier: DefenseTier,
    /// Optional tools for verification (tool names)
    #[serde(default)]
    pub tools: Vec<String>,
    /// Fast-path signatures extracted from this antibody's detections
    #[serde(default)]
    pub memory_signatures: Vec<Signature>,
    /// Runtime dependencies needed by this antibody (e.g. node, tsx)
    #[serde(default)]
    pub deps: Vec<String>,
    pub threshold: f64,
    /// SHM generation number (0 = original/builtin)
    #[serde(default)]
    pub generation: u32,
    /// Parent antibody ID (lineage tracking)
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Current performance on validation set
    #[serde(default)]
    pub affinity_score: f64,
    #[serde(default)]
    pub stats: AntibodyStats,
    #[serde(default)]
    pub status: AntibodyStatus,
    pub created_at: DateTime<Utc>,
    #[serde(default = "Utc::now")]
    pub last_used_at: DateTime<Utc>,
}

/// A novel attack sample that may trigger vaccination.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Antigen {
    pub id: String,
    /// Raw attack content
    pub content: String,
    /// Source of the content (web, mcp, tool_output, file)
    pub source_type: String,
    pub category: AttackCategory,
    /// Extracted features (URLs, code patterns, etc.)
    #[serde(default)]
    pub features: serde_json::Value,
    /// Which antibodies failed to detect this
    #[serde(default)]
    pub escaped_antibodies: Vec<String>,
    /// Agent context snapshot at time of attack
    #[serde(default)]
    pub context_snapshot: serde_json::Value,
    pub timestamp: DateTime<Utc>,
    /// Antibody ID that eventually resolved this (if any)
    #[serde(default)]
    pub resolved_by: Option<String>,
}

/// Fast-path memory entry for known attack signatures.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub signature: String,
    pub signature_type: SignatureType,
    pub antibody_id: String,
    pub antigen_id: String,
    pub category: AttackCategory,
    pub hit_count: u64,
    pub last_hit: DateTime<Utc>,
    /// Optional embedding for semantic matching
    #[serde(default)]
    pub embedding: Option<Vec<f32>>,
}

/// Scan verdict.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum Verdict {
    #[serde(rename = "safe")]
    Safe,
    #[serde(rename = "suspicious")]
    Suspicious,
    #[serde(rename = "malicious")]
    Malicious,
}

/// Result from a single antibody scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AntibodyResult {
    pub antibody_id: String,
    pub antibody_name: String,
    pub verdict: Verdict,
    /// Confidence score 0.0-1.0
    pub confidence: f64,
    /// LLM reasoning trace
    pub reasoning: String,
    pub matched_signatures: Vec<String>,
    pub tier: DefenseTier,
    /// Latency in microseconds
    pub latency_us: u64,
    pub tokens_used: u64,
}

/// Full scan result returned to the caller.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub verdict: Verdict,
    pub confidence: f64,
    pub antibody_results: Vec<AntibodyResult>,
    pub matched_memory: Vec<MemoryEntry>,
    pub total_latency_us: u64,
    pub total_tokens: u64,
    /// Whether a vaccination was triggered by this scan
    pub triggered_vaccination: bool,
}

/// Context provided by the caller for a scan.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ScanContext {
    /// Source type of the content (e.g., "web_search", "tool_output", "mcp")
    pub source: String,
    /// The agent's current task description
    pub agent_task: Option<String>,
    /// Recent conversation context
    pub history_snippet: Option<String>,
    /// Additional metadata
    #[serde(default)]
    pub metadata: serde_json::Value,
}
