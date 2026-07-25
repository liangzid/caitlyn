use tracing::{debug, info};

use crate::core::{Antibody, AntibodyStatus, DefenseTier};
#[cfg(test)]
use crate::core::AttackCategory;
use crate::error::CaitlynResult;
use crate::llm::LlmProvider;

/// Temperature range for SHM mutations.
const TEMPERATURE_MIN: f64 = 0.3;
const TEMPERATURE_MAX: f64 = 0.95;
const TEMPERATURE_STEP: f64 = 0.1;

/// Somatic Hypermutation Engine — generates semantic variants of antibodies.
pub struct ShmEngine {
    /// Base temperature for mutation aggressiveness
    pub base_temperature: f64,
    /// Current adaptive temperature
    current_temperature: f64,
    /// Consecutive successful vaccinations (for adaptive temperature)
    consecutive_successes: u32,
    /// Consecutive failed vaccinations
    consecutive_failures: u32,
}

impl ShmEngine {
    pub fn new(base_temperature: f64) -> Self {
        Self {
            base_temperature,
            current_temperature: base_temperature,
            consecutive_successes: 0,
            consecutive_failures: 0,
        }
    }

    /// Get current adaptive temperature.
    pub fn temperature(&self) -> f64 {
        self.current_temperature
    }

    /// Record a successful vaccination → potentially increase temperature.
    pub fn record_success(&mut self) {
        self.consecutive_successes += 1;
        self.consecutive_failures = 0;
        if self.consecutive_successes >= 3 {
            self.current_temperature =
                (self.current_temperature + TEMPERATURE_STEP).min(TEMPERATURE_MAX);
            self.consecutive_successes = 0;
            debug!("SHM temperature increased to {:.2}", self.current_temperature);
        }
    }

    /// Record a failed vaccination → decrease temperature.
    pub fn record_failure(&mut self) {
        self.consecutive_failures += 1;
        self.consecutive_successes = 0;
        self.current_temperature =
            (self.current_temperature - TEMPERATURE_STEP).max(TEMPERATURE_MIN);
        debug!("SHM temperature decreased to {:.2}", self.current_temperature);
    }

    /// Generate N semantic variants of a parent antibody using LLM-driven mutation.
    pub async fn mutate(
        &self,
        parent: &Antibody,
        antigen_samples: &[String],
        n_variants: usize,
        llm: &dyn LlmProvider,
    ) -> CaitlynResult<Vec<Antibody>> {
        let system_prompt = build_shm_system_prompt(parent, self.current_temperature);
        let user_prompt = build_shm_user_prompt(parent, antigen_samples, n_variants);

        info!(
            "SHM: generating {} variants from parent '{}' (temperature={:.2})",
            n_variants,
            parent.name,
            self.current_temperature
        );

        let raw_output = llm
            .generate(&system_prompt, &user_prompt, self.current_temperature)
            .await?;

        // Parse the LLM output into antibody variants
        parse_variants(&raw_output, parent)
    }
}

fn build_shm_system_prompt(parent: &Antibody, temperature: f64) -> String {
    format!(
        r#"You are an expert at evolving AI defense systems through semantic mutation.
Your task is to create variants of a defense antibody that detect a specific attack pattern.

## Parent Antibody
Name: {name}
Description: {desc}
Category: {category}
Tier: {tier}
Current Prompt:
---
{prompt}
---
Current threshold: {threshold}

## Mutation Guidelines
Temperature = {temp:.2} (0.0=conservative, 1.0=radical)

Available mutation operations:
1. PROMPT_REPHRASE: Rewrite detection instructions with different framing
2. HEURISTIC_ADD: Add new detection patterns/heuristics
3. HEURISTIC_PRUNE: Remove redundant or noisy patterns
4. THRESHOLD_TUNE: Adjust confidence threshold
5. SCOPE_EXPAND: Broaden to cover related attack variants
6. SCOPE_NARROW: Narrow to reduce false positive surface
7. SIGNATURE_EXTRACT: Identify exact/regex patterns for fast-path matching

Each variant MUST:
- Be structurally valid (name, description, prompt, threshold)
- Be semantically different from siblings
- Still detect the parent's attack category
- Target Tier 1 (Specialized) — fast, single LLM call, no tools

Output as a JSON array of antibody objects."#,
        name = parent.name,
        desc = parent.description,
        category = format!("{:?}", parent.category),
        tier = parent.tier as u8,
        prompt = parent.prompt,
        threshold = parent.threshold,
        temp = temperature,
    )
}

fn build_shm_user_prompt(
    parent: &Antibody,
    antigen_samples: &[String],
    n_variants: usize,
) -> String {
    let samples_text = antigen_samples
        .iter()
        .enumerate()
        .map(|(i, s)| format!("### Sample {}\n```\n{}\n```", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n\n");

    format!(
        r#"## Attack Samples That Must Be Detected

{samples}

## Task
Generate exactly {n} variants of the "{name}" antibody.
Each variant must detect ALL the above attack samples while minimizing false positives.

Output as JSON:
```json
[
  {{
    "name": "variant name",
    "description": "what this variant detects and how",
    "prompt": "the detection system prompt",
    "threshold": 0.7,
    "mutation_operations": ["PROMPT_REPHRASE", "HEURISTIC_ADD"],
    "new_signatures": ["exact pattern 1"]
  }},
  ...
]
```"#,
        samples = samples_text,
        n = n_variants,
        name = parent.name,
    )
}

/// Parse LLM output into Antibody structs.
fn parse_variants(raw: &str, parent: &Antibody) -> CaitlynResult<Vec<Antibody>> {
    // Try to extract JSON array from the response
    let json_str = extract_json_array(raw)
        .unwrap_or(raw);

    let variants: Vec<ShmVariant> = serde_json::from_str(json_str)
        .map_err(|e| {
            crate::error::CaitlynError::Evolution(format!(
                "Failed to parse SHM output: {e}. Raw: {}",
                &raw[..raw.len().min(500)]
            ))
        })?;

    let now = chrono::Utc::now();
    let antibodies: Vec<Antibody> = variants
        .into_iter()
        .enumerate()
        .map(|(i, v)| Antibody {
            id: format!("{}-shm-{}", parent.id, i + 1),
            name: v.name,
            description: v.description,
            prompt: v.prompt,
            category: parent.category.clone(),
            tier: DefenseTier::Specialized, // Target Tier 1
            tools: vec![],                  // Specialized = no tools
            memory_signatures: v
                .new_signatures
                .into_iter()
                .map(|p| crate::core::Signature {
                    pattern: p,
                    sig_type: crate::core::SignatureType::Exact,
                    label: None,
                })
                .collect(),
            threshold: v.threshold.clamp(0.3, 0.95),
            generation: parent.generation + 1,
            parent_id: Some(parent.id.clone()),
            affinity_score: 0.0,
            stats: Default::default(),
            deps: parent.deps.clone(),
            status: AntibodyStatus::Candidate,
            created_at: now,
            last_used_at: now,
        })
        .collect();

    Ok(antibodies)
}

/// Extract the first JSON array from a string.
fn extract_json_array(s: &str) -> Option<&str> {
    let start = s.find('[')?;
    let mut depth = 0;
    let mut in_string = false;
    let mut escape_next = false;

    for (i, c) in s[start..].char_indices() {
        if escape_next {
            escape_next = false;
            continue;
        }
        match c {
            '\\' if in_string => escape_next = true,
            '"' => in_string = !in_string,
            '[' if !in_string => depth += 1,
            ']' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[start..start + i + 1]);
                }
            }
            _ => {}
        }
    }
    None
}

#[derive(Debug, serde::Deserialize)]
struct ShmVariant {
    name: String,
    description: String,
    prompt: String,
    #[serde(default = "default_threshold")]
    threshold: f64,
    #[serde(default)]
    new_signatures: Vec<String>,
}

fn default_threshold() -> f64 {
    0.7
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_json_array_simple() {
        let input = r#"Some text before [{"name": "test", "threshold": 0.8}] and after"#;
        let result = extract_json_array(input);
        assert!(result.is_some());
        assert!(result.unwrap().starts_with('['));
    }

    #[test]
    fn test_extract_json_array_nested() {
        let input = r#"Output: [{"name": "v1", "signatures": ["a", "b"]}, {"name": "v2"}] done"#;
        let result = extract_json_array(input);
        assert!(result.is_some());
    }

    #[test]
    fn test_extract_json_array_none() {
        let result = extract_json_array("no array here");
        assert!(result.is_none());
    }

    #[test]
    fn test_shm_engine_adaptive_temperature() {
        let mut engine = ShmEngine::new(0.8);
        assert_eq!(engine.temperature(), 0.8);

        // Failures should decrease temperature
        engine.record_failure();
        engine.record_failure();
        assert!(engine.temperature() < 0.8);

        // Successes should increase temperature
        engine.record_success();
        engine.record_success();
        engine.record_success();
        assert!(engine.temperature() >= 0.7);
    }

    #[test]
    fn test_parse_variants() {
        let parent = Antibody {
            id: "parent-1".into(),
            name: "Test Parent".into(),
            description: "Test".into(),
            prompt: "Test prompt".into(),
            category: AttackCategory::Injection,
            tier: DefenseTier::General,
            tools: vec![],
            memory_signatures: vec![],
            threshold: 0.7,
            generation: 0,
            parent_id: None,
            affinity_score: 0.0,
            deps: vec![],
            stats: Default::default(),
            status: AntibodyStatus::Active,
            created_at: chrono::Utc::now(),
            last_used_at: chrono::Utc::now(),
        };

        let json = r#"[
            {"name": "Variant 1", "description": "Detects X", "prompt": "You detect X", "threshold": 0.75, "new_signatures": ["DROP"]},
            {"name": "Variant 2", "description": "Detects Y", "prompt": "You detect Y", "threshold": 0.8, "new_signatures": ["UNION"]}
        ]"#;

        let variants = parse_variants(json, &parent).unwrap();
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0].name, "Variant 1");
        assert_eq!(variants[0].tier, DefenseTier::Specialized);
        assert_eq!(variants[0].generation, 1);
        assert_eq!(variants[0].parent_id, Some("parent-1".into()));
        assert_eq!(variants[0].memory_signatures.len(), 1);
    }
}
