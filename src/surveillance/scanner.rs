use std::sync::Arc;
use std::time::Instant;
use tracing::{debug, warn};

use crate::config::ScanningConfig;
use crate::core::{
    AntibodyPool, AntibodyResult, DefenseTier, MemoryBank, ScanContext, ScanResult, Verdict,
};
use crate::llm::LlmProvider;
use crate::surveillance::cost_monitor::CostMonitor;
use crate::error::CaitlynResult;

/// Executes the multi-tier surveillance loop.
pub struct SurveillanceScanner {
    config: ScanningConfig,
}

impl SurveillanceScanner {
    pub fn new(config: ScanningConfig) -> Self {
        Self { config }
    }

    /// Run the full surveillance loop against content.
    pub async fn scan(
        &self,
        content: &str,
        context: &ScanContext,
        antibody_pool: &AntibodyPool,
        memory_bank: &MemoryBank,
        cost_monitor: &CostMonitor,
        llm: Arc<dyn LlmProvider>,
    ) -> CaitlynResult<ScanResult> {
        let scan_start = Instant::now();
        let mut antibody_results = Vec::new();
        let mut total_tokens = 0u64;
        let mut triggered_vaccination = false;

        // === TIER 0: Memory Fast-Path ===
        let memory_start = Instant::now();
        let memory_match = memory_bank.check(content).await;
        let memory_latency = memory_start.elapsed().as_micros() as u64;
        debug!("Tier 0 memory check: {}μs", memory_latency);
        if let crate::core::memory::MemoryMatch::Exact(ref entry) = memory_match {
            return Ok(ScanResult {
                verdict: Verdict::Malicious,
                confidence: 1.0,
                antibody_results: vec![],
                matched_memory: vec![entry.clone()],
                total_latency_us: scan_start.elapsed().as_micros() as u64,
                total_tokens: 0,
                triggered_vaccination: false,
            });
        }

        // === TIER 1: Specialized Antibodies (parallel) ===
        let tier1_antibodies = antibody_pool.get_active(Some(DefenseTier::Specialized)).await;
        if !tier1_antibodies.is_empty() {
            debug!(
                "Running {} Tier 1 specialized antibodies",
                tier1_antibodies.len()
            );
            let results = self
                .run_antibody_batch(
                    &tier1_antibodies,
                    content,
                    context,
                    Arc::clone(&llm),
                    0.3, // Low temperature for specialized antibodies
                    self.config.tier1_timeout_ms,
                    self.config.max_parallel_tier1,
                )
                .await;

            for r in results {
                total_tokens += r.tokens_used;
                // Early exit: high-confidence malicious from Tier 1
                if r.verdict == Verdict::Malicious && r.confidence > 0.9 {
                    antibody_results.push(r);
                    let result = ScanResult {
                        verdict: Verdict::Malicious,
                        confidence: 0.95,
                        antibody_results,
                        matched_memory: vec![],
                        total_latency_us: scan_start.elapsed().as_micros() as u64,
                        total_tokens,
                        triggered_vaccination: false,
                    };
                    return Ok(result);
                }
                antibody_results.push(r);
            }
        }

        // === TIER 2: General Antibodies (parallel) ===
        let tier2_antibodies = antibody_pool.get_active(Some(DefenseTier::General)).await;
        if !tier2_antibodies.is_empty() {
            debug!(
                "Running {} Tier 2 general antibodies",
                tier2_antibodies.len()
            );
            let results = self
                .run_antibody_batch(
                    &tier2_antibodies,
                    content,
                    context,
                    Arc::clone(&llm),
                    0.5, // Moderate temperature for general antibodies
                    self.config.tier2_timeout_ms,
                    self.config.max_parallel_tier2,
                )
                .await;

            for r in results {
                total_tokens += r.tokens_used;
                antibody_results.push(r);
            }
        }

        // === AGGREGATION ===
        let verdict = self.aggregate(&antibody_results);

        // === COST RECORDING ===
        let total_latency = scan_start.elapsed().as_micros() as u64;
        let pattern_hash = CostMonitor::compute_pattern_hash(content);

        if verdict == Verdict::Malicious || verdict == Verdict::Suspicious {
            let resolved_by: Vec<String> = antibody_results
                .iter()
                .filter(|r| r.verdict == Verdict::Malicious)
                .map(|r| r.antibody_id.clone())
                .collect();

            cost_monitor
                .record(
                    &pattern_hash,
                    content,
                    // Infer category from context
                    crate::core::AttackCategory::Unknown,
                    resolved_by.clone(),
                    verdict == Verdict::Malicious,
                    total_latency,
                    total_tokens,
                )
                .await;

            // Check if vaccination should be triggered
            let triggers = cost_monitor.check_vaccination_triggers().await;
            if !triggers.is_empty() {
                triggered_vaccination = true;
                debug!(
                    "Vaccination triggered for {} patterns",
                    triggers.len()
                );
            }
        }

        Ok(ScanResult {
            verdict,
            confidence: self.compute_confidence(&antibody_results),
            antibody_results,
            matched_memory: vec![],
            total_latency_us: total_latency,
            total_tokens,
            triggered_vaccination,
        })
    }

    /// Run a batch of antibodies in parallel with a concurrency limit.
    async fn run_antibody_batch(
        &self,
        antibodies: &[crate::core::Antibody],
        content: &str,
        _context: &ScanContext,
        llm: Arc<dyn LlmProvider>,
        temperature: f64,
        _timeout_ms: u64,
        max_parallel: usize,
    ) -> Vec<AntibodyResult> {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(max_parallel.max(1)));
        let mut handles = Vec::with_capacity(antibodies.len());

        for antibody in antibodies {
            let content = content.to_string();
            let antibody = antibody.clone();
            let llm = Arc::clone(&llm);
            let permit = Arc::clone(&semaphore);

            let handle = tokio::spawn(async move {
                let _permit = permit.acquire().await;
                let start = Instant::now();
                let result = llm
                    .scan(&antibody.prompt, &content, temperature)
                    .await;

                match result {
                    Ok(output) => AntibodyResult {
                        antibody_id: antibody.id.clone(),
                        antibody_name: antibody.name.clone(),
                        verdict: match output.verdict.as_str() {
                            "malicious" => Verdict::Malicious,
                            "suspicious" => Verdict::Suspicious,
                            _ => Verdict::Safe,
                        },
                        confidence: output.confidence.clamp(0.0, 1.0),
                        reasoning: output.reasoning,
                        matched_signatures: output.matched_patterns,
                        tier: antibody.tier,
                        latency_us: start.elapsed().as_micros() as u64,
                        tokens_used: output.tokens_used,
                    },
                    Err(e) => {
                        warn!(
                            "Antibody '{}' scan failed: {e}",
                            antibody.name
                        );
                        AntibodyResult {
                            antibody_id: antibody.id.clone(),
                            antibody_name: antibody.name.clone(),
                            verdict: Verdict::Suspicious,
                            confidence: 0.0,
                            reasoning: format!("Scan error: {e}"),
                            matched_signatures: vec![],
                            tier: antibody.tier,
                            latency_us: start.elapsed().as_micros() as u64,
                            tokens_used: 0,
                        }
                    }
                }
            });

            handles.push(handle);
        }

        let results = futures::future::join_all(handles).await;
        results
            .into_iter()
            .filter_map(|r| r.ok())
            .collect()
    }

    /// Aggregate individual antibody results into a single verdict.
    fn aggregate(&self, results: &[AntibodyResult]) -> Verdict {
        if results.is_empty() {
            return Verdict::Safe;
        }

        let malicious_votes: f64 = results
            .iter()
            .filter(|r| r.verdict == Verdict::Malicious)
            .map(|r| r.confidence)
            .sum();
        let suspicious_votes: f64 = results
            .iter()
            .filter(|r| r.verdict == Verdict::Suspicious)
            .map(|r| r.confidence)
            .sum();
        let safe_votes: f64 = results
            .iter()
            .filter(|r| r.verdict == Verdict::Safe)
            .map(|r| r.confidence)
            .sum();

        let total = malicious_votes + suspicious_votes + safe_votes;
        if total == 0.0 {
            return Verdict::Safe;
        }

        // Weighted: malicious gets 2x weight
        let weighted_malicious = malicious_votes * 2.0;
        let weighted_suspicious = suspicious_votes * 1.0;

        if weighted_malicious > weighted_suspicious && weighted_malicious > safe_votes {
            Verdict::Malicious
        } else if weighted_suspicious > safe_votes {
            Verdict::Suspicious
        } else {
            Verdict::Safe
        }
    }

    fn compute_confidence(&self, results: &[AntibodyResult]) -> f64 {
        if results.is_empty() {
            return 0.5;
        }
        let sum: f64 = results.iter().map(|r| r.confidence).sum();
        (sum / results.len() as f64).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aggregate_all_safe() {
        let scanner = SurveillanceScanner::new(Default::default());
        let results = vec![
            AntibodyResult {
                antibody_id: "1".into(),
                antibody_name: "test".into(),
                verdict: Verdict::Safe,
                confidence: 0.9,
                reasoning: "".into(),
                matched_signatures: vec![],
                tier: DefenseTier::General,
                latency_us: 0,
                tokens_used: 0,
            },
            AntibodyResult {
                antibody_id: "2".into(),
                antibody_name: "test2".into(),
                verdict: Verdict::Safe,
                confidence: 0.8,
                reasoning: "".into(),
                matched_signatures: vec![],
                tier: DefenseTier::General,
                latency_us: 0,
                tokens_used: 0,
            },
        ];
        assert_eq!(scanner.aggregate(&results), Verdict::Safe);
    }

    #[test]
    fn test_aggregate_one_malicious() {
        let scanner = SurveillanceScanner::new(Default::default());
        let results = vec![
            AntibodyResult {
                antibody_id: "1".into(),
                antibody_name: "test".into(),
                verdict: Verdict::Safe,
                confidence: 0.9,
                reasoning: "".into(),
                matched_signatures: vec![],
                tier: DefenseTier::General,
                latency_us: 0,
                tokens_used: 0,
            },
            AntibodyResult {
                antibody_id: "2".into(),
                antibody_name: "test2".into(),
                verdict: Verdict::Malicious,
                confidence: 0.95,
                reasoning: "".into(),
                matched_signatures: vec![],
                tier: DefenseTier::General,
                latency_us: 0,
                tokens_used: 0,
            },
        ];
        // Weighted: malicious = 0.95*2 = 1.9, safe = 0.9
        assert_eq!(scanner.aggregate(&results), Verdict::Malicious);
    }

    #[test]
    fn test_aggregate_empty() {
        let scanner = SurveillanceScanner::new(Default::default());
        assert_eq!(scanner.aggregate(&[]), Verdict::Safe);
    }
}
