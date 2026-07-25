use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::CaitlynResult;

/// Result from an LLM call for antibody scanning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmScanOutput {
    pub verdict: String,     // "safe" | "suspicious" | "malicious"
    pub confidence: f64,     // 0.0 - 1.0
    pub reasoning: String,
    pub matched_patterns: Vec<String>,
    pub tokens_used: u64,
}

/// Generic LLM provider trait.
#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// Call the LLM with a system prompt and user content.
    /// Returns structured output for security analysis.
    async fn scan(
        &self,
        system_prompt: &str,
        user_content: &str,
        temperature: f64,
    ) -> CaitlynResult<LlmScanOutput>;

    /// Call the LLM for antibody generation (used in vaccination).
    async fn generate(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        temperature: f64,
    ) -> CaitlynResult<String>;

    /// Provider name for logging.
    fn name(&self) -> &str;
}

// Re-export DeepSeek provider
pub mod deepseek;
pub use deepseek::DeepSeekProvider;
