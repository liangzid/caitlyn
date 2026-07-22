use tracing::{info, warn};

use crate::config::VaccinationConfig;
use crate::core::{Antibody, AntibodyPool, MemoryBank};
use crate::error::CaitlynResult;
use crate::evolution::affinity::{AffinityConfig, AffinityMaturation, LabeledSample};
use crate::evolution::shm::ShmEngine;
use crate::llm::LlmProvider;
use crate::surveillance::cost_monitor::CostMonitor;

/// The vaccination pipeline — triggered when defense cost exceeds threshold.
///
/// Flow: SHM → Affinity Maturation → Clonal Selection → Memory Extraction
pub struct VaccinationPipeline {
    config: VaccinationConfig,
    shm: ShmEngine,
    affinity: AffinityMaturation,
}

impl VaccinationPipeline {
    pub fn new(config: VaccinationConfig) -> Self {
        let shm = ShmEngine::new(config.shm_base_temperature);
        let affinity = AffinityMaturation::new(AffinityConfig {
            recall_weight: config.affinity_recall_weight,
            precision_weight: 1.0 - config.affinity_recall_weight,
            fp_penalty: config.fp_tolerance * 4.0, // Scale FP tolerance to penalty
            survival_threshold: 0.6,
            max_survivors: config.max_survivors,
        });

        Self {
            config,
            shm,
            affinity,
        }
    }

    /// Execute the full vaccination pipeline for a cost pattern.
    ///
    /// Returns the best surviving antibody, if any.
    pub async fn vaccinate(
        &mut self,
        pattern_hash: &str,
        antibody_pool: &AntibodyPool,
        memory_bank: &MemoryBank,
        cost_monitor: &CostMonitor,
        llm: &dyn LlmProvider,
        validation_set: &ValidationSet,
    ) -> CaitlynResult<Option<Antibody>> {
        let record = cost_monitor
            .get(pattern_hash)
            .await
            .ok_or_else(|| crate::error::CaitlynError::Vaccination(format!(
                "Pattern '{}' not found in cost monitor",
                pattern_hash
            )))?;

        info!(
            "Starting vaccination for pattern '{}' ({} calls, avg latency={}μs, avg tokens={})",
            &pattern_hash[..8],
            record.call_count,
            record.avg_latency_us(),
            record.avg_tokens(),
        );

        // Step 1: Identify the parent antibody (the one that resolved attacks most)
        let parent_id = record
            .resolved_by
            .first()
            .cloned()
            .unwrap_or_else(|| "builtin-injection-general".into());

        let parent = match antibody_pool.get(&parent_id).await {
            Ok(ab) => ab,
            Err(_) => {
                warn!("Parent antibody '{}' not found, skipping vaccination", parent_id);
                return Ok(None);
            }
        };

        // Step 2: Collect antigen samples
        let antigen_samples = vec![record.sample.clone()]; // TODO: collect more samples

        // Step 3: SHM — generate variants
        let variants = self
            .shm
            .mutate(&parent, &antigen_samples, self.config.shm_variants, llm)
            .await?;

        if variants.is_empty() {
            warn!("SHM produced no variants, skipping vaccination");
            self.shm.record_failure();
            return Ok(None);
        }

        info!("SHM generated {} candidate variants", variants.len());

        // Step 4: Affinity Maturation — evaluate against validation set
        // Build a simple scanner from LLM
        let scanner = |_prompt: &str, content: &str| -> (bool, f64) {
            // In production this would use the LLM; for MVP we use a simplified approach
            // Check if any signature from the prompt matches the content
            let lower_content = content.to_lowercase();
            let suspicious_patterns = [
                "drop table", "ignore previous", "you are now",
                "[system]", "union select", "or 1=1",
            ];
            for pat in &suspicious_patterns {
                if lower_content.contains(pat) {
                    return (true, 0.8);
                }
            }
            (false, 0.1)
        };

        let must_detect: Vec<LabeledSample> = antigen_samples
            .iter()
            .map(|s| LabeledSample {
                content: s.clone(),
                is_attack: true,
            })
            .collect();

        let should_detect: Vec<LabeledSample> = validation_set
            .attacks
            .iter()
            .map(|s| LabeledSample {
                content: s.clone(),
                is_attack: true,
            })
            .collect();

        let must_not_detect: Vec<LabeledSample> = validation_set
            .benign
            .iter()
            .map(|s| LabeledSample {
                content: s.clone(),
                is_attack: false,
            })
            .collect();

        let results = self.affinity.evaluate(
            variants,
            &must_detect,
            &should_detect,
            &must_not_detect,
            &scanner,
        );

        // Step 5: Clonal Selection
        let survivors = self.affinity.select_survivors(results);

        if survivors.is_empty() {
            warn!("No variants survived affinity maturation");
            self.shm.record_failure();
            return Ok(None);
        }

        info!(
            "Clonal selection: {} survivors (best affinity={:.3})",
            survivors.len(),
            survivors.first().map(|s| s.affinity_score).unwrap_or(0.0)
        );

        // Step 6: Add survivors to antibody pool
        let best = survivors[0].clone();
        for survivor in &survivors {
            antibody_pool
                .add(survivor.clone())
                .await
                .map_err(|e| {
                    crate::error::CaitlynError::Vaccination(format!(
                        "Failed to add survivor '{}': {e}",
                        survivor.id
                    ))
                })?;

            // Extract memory signatures
            for sig in &survivor.memory_signatures {
                let entry = crate::core::MemoryEntry {
                    id: format!("mem-{}", uuid::Uuid::new_v4()),
                    signature: sig.pattern.clone(),
                    signature_type: sig.sig_type.clone(),
                    antibody_id: survivor.id.clone(),
                    antigen_id: pattern_hash.to_string(),
                    category: survivor.category.clone(),
                    hit_count: 0,
                    last_hit: chrono::Utc::now(),
                    embedding: None,
                };
                memory_bank.add(entry).await?;
            }
        }

        // Step 7: Mark as vaccinated
        cost_monitor
            .mark_vaccinated(pattern_hash, &best.id)
            .await;

        self.shm.record_success();

        info!(
            "Vaccination complete: antibody '{}' deployed for pattern '{}'",
            best.name,
            &pattern_hash[..8]
        );

        Ok(Some(best))
    }
}

/// Validation set used for affinity maturation.
#[derive(Debug, Clone, Default)]
pub struct ValidationSet {
    /// Known attack samples for cross-validation
    pub attacks: Vec<String>,
    /// Benign samples (normal agent operation)
    pub benign: Vec<String>,
    /// Edge cases (look suspicious but are safe)
    pub edge_cases: Vec<String>,
}

impl ValidationSet {
    /// Load from JSONL files.
    pub fn load(attacks_path: &str, benign_path: &str) -> CaitlynResult<Self> {
        let attacks = if std::path::Path::new(attacks_path).exists() {
            load_jsonl(attacks_path)?
        } else {
            Vec::new()
        };

        let benign = if std::path::Path::new(benign_path).exists() {
            load_jsonl(benign_path)?
        } else {
            Vec::new()
        };

        Ok(Self {
            attacks,
            benign,
            edge_cases: Vec::new(),
        })
    }
}

fn load_jsonl(path: &str) -> CaitlynResult<Vec<String>> {
    let content = std::fs::read_to_string(path)?;
    let samples: Vec<String> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| {
            serde_json::from_str::<serde_json::Value>(l)
                .ok()
                .and_then(|v| v.get("content").and_then(|c| c.as_str().map(String::from)))
        })
        .collect();
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_jsonl() {
        // Create a temp file
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.jsonl");
        std::fs::write(
            &path,
            "{\"content\": \"DROP TABLE users\"}\n{\"content\": \"SELECT * FROM data\"}\n",
        )
        .unwrap();

        let samples = load_jsonl(path.to_str().unwrap()).unwrap();
        assert_eq!(samples.len(), 2);
        assert!(samples[0].contains("DROP"));
    }

    #[test]
    fn test_validation_set_load_nonexistent() {
        let vs = ValidationSet::load("/nonexistent/path.jsonl", "/also/nonexistent.jsonl").unwrap();
        assert!(vs.attacks.is_empty());
        assert!(vs.benign.is_empty());
    }
}
