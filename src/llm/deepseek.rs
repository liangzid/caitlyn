use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value;
use tracing::debug;

use super::{LlmProvider, LlmScanOutput};
use crate::error::{CaitlynError, CaitlynResult};

/// DeepSeek API provider.
pub struct DeepSeekProvider {
    client: Client,
    api_key: String,
    base_url: String,
    model: String,
}

impl DeepSeekProvider {
    pub fn new(api_key: String, base_url: String, model: String) -> Self {
        Self {
            client: Client::new(),
            api_key,
            base_url,
            model,
        }
    }

    /// Create from environment variable.
    pub fn from_env(api_key_env: &str, base_url: &str, model: &str) -> CaitlynResult<Self> {
        let api_key = std::env::var(api_key_env).map_err(|_| {
            CaitlynError::LlmProvider(format!(
                "Environment variable '{}' not set",
                api_key_env
            ))
        })?;
        Ok(Self::new(api_key, base_url.to_string(), model.to_string()))
    }

    /// Create from standard environment variables.
    /// Reads CAITLYN_LLM_API_KEY (or OPENROUTER_API_KEY or DEEPSEEK_API_KEY),
    /// CAITLYN_LLM_BASE_URL (default: OpenRouter), CAITLYN_LLM_MODEL (default: deepseek/deepseek-chat).
    pub fn from_env_defaults() -> CaitlynResult<Self> {
        let api_key = std::env::var("OPENROUTER_API_KEY")
            .or_else(|_| std::env::var("DEEPSEEK_API_KEY"))
            .or_else(|_| std::env::var("CAITLYN_LLM_API_KEY"))
            .map_err(|_| CaitlynError::Config(
                "No API key found. Set OPENROUTER_API_KEY or DEEPSEEK_API_KEY or CAITLYN_LLM_API_KEY".into()
            ))?;
        let base_url = std::env::var("CAITLYN_LLM_BASE_URL")
            .or_else(|_| std::env::var("DEEPSEEK_BASE_URL"))
            .unwrap_or_else(|_| "https://openrouter.ai/api".into());
        let model = std::env::var("CAITLYN_LLM_MODEL")
            .or_else(|_| std::env::var("DEEPSEEK_MODEL"))
            .unwrap_or_else(|_| "deepseek/deepseek-chat".into());
        Ok(Self::new(api_key, base_url, model))
    }

    async fn chat_completion(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        temperature: f64,
        response_format: Option<Value>,
    ) -> CaitlynResult<(String, u64)> {
        let url = format!("{}/v1/chat/completions", self.base_url.trim_end_matches('/'));

        let messages = vec![
            serde_json::json!({
                "role": "system",
                "content": system_prompt
            }),
            serde_json::json!({
                "role": "user",
                "content": user_prompt
            }),
        ];

        let mut body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
        });
        let max_tokens = std::env::var("CAITLYN_MAX_TOKENS")
            .ok().and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(4096);
        body["max_tokens"] = serde_json::json!(max_tokens);

        if let Some(format) = response_format {
            body["response_format"] = format;
        }

        debug!("LLM request to {}: {} chars", url, user_prompt.len());

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| CaitlynError::LlmProvider(format!("HTTP request failed: {e}")))?;

        let status = response.status();
        let response_text = response
            .text()
            .await
            .map_err(|e| CaitlynError::LlmProvider(format!("Failed to read response: {e}")))?;

        if !status.is_success() {
            return Err(CaitlynError::LlmProvider(format!(
                "LLM API error ({}): {}",
                status, response_text
            )));
        }

        let json: Value = serde_json::from_str(&response_text)
            .map_err(|e| CaitlynError::LlmProvider(format!("Failed to parse response JSON: {e}")))?;

        let content = json["choices"][0]["message"]["content"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| CaitlynError::LlmProvider(
                "LLM returned empty response".into()
            ))?
            .to_string();

        let tokens_used = json["usage"]["total_tokens"]
            .as_u64()
            .filter(|&t| t > 0)
            .unwrap_or_else(|| {
                // Fallback: estimate from response length when API omits usage info.
                // Conservative heuristic: ~4 characters per token for English text.
                (content.len() as u64 / 4).max(1)
            });

        Ok((content, tokens_used))
    }
}

#[async_trait]
impl LlmProvider for DeepSeekProvider {
    async fn scan(
        &self,
        system_prompt: &str,
        user_content: &str,
        temperature: f64,
    ) -> CaitlynResult<LlmScanOutput> {
        let full_user_prompt = format!(
            "Content to analyze:\n---\n{}\n---\n\nOutput your analysis as a JSON object with the following fields:\n\
             - verdict: \"safe\", \"suspicious\", or \"malicious\"\n\
             - confidence: float between 0.0 and 1.0\n\
             - reasoning: your analysis reasoning\n\
             - matched_patterns: list of specific patterns you detected",
            user_content
        );

        let response_format = serde_json::json!({
            "type": "json_object"
        });

        let (raw_output, tokens_used) = self
            .chat_completion(system_prompt, &full_user_prompt, temperature, Some(response_format))
            .await?;

        // Parse structured JSON output
        let mut parsed: LlmScanOutput = serde_json::from_str(&raw_output).unwrap_or_else(|e| {
            // Fallback: try to extract JSON from the response
            debug!("Failed to parse structured output, attempting extraction: {e}");
            LlmScanOutput {
                verdict: "suspicious".to_string(),
                confidence: 0.5,
                reasoning: raw_output,
                matched_patterns: vec![],
                tokens_used,
            }
        });

        parsed.tokens_used = tokens_used;

        Ok(parsed)
    }

    async fn generate(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        temperature: f64,
    ) -> CaitlynResult<String> {
        let (content, _tokens) =
            self.chat_completion(system_prompt, user_prompt, temperature, None)
                .await?;
        Ok(content)
    }

    fn name(&self) -> &str {
        "deepseek"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_provider() {
        let provider = DeepSeekProvider::new(
            "sk-test".into(),
            "https://api.deepseek.com".into(),
            "deepseek-chat".into(),
        );
        assert_eq!(provider.name(), "deepseek");
    }

    #[test]
    fn test_from_env_missing_key() {
        // Key doesn't exist — should return error
        let result = DeepSeekProvider::from_env(
            "NONEXISTENT_KEY_THAT_DOES_NOT_EXIST",
            "https://api.deepseek.com",
            "deepseek-chat",
        );
        assert!(result.is_err());
    }
}
