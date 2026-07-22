use tracing::info;

use crate::core::Antibody;

/// Configuration for affinity maturation.
#[derive(Debug, Clone)]
pub struct AffinityConfig {
    /// Weight for recall (detecting attacks)
    pub recall_weight: f64,
    /// Weight for precision (avoiding false positives)
    pub precision_weight: f64,
    /// Penalty factor for false positives
    pub fp_penalty: f64,
    /// Minimum score to survive
    pub survival_threshold: f64,
    /// Maximum number of survivors to keep
    pub max_survivors: usize,
}

impl Default for AffinityConfig {
    fn default() -> Self {
        Self {
            recall_weight: 0.7,
            precision_weight: 0.3,
            fp_penalty: 0.2,
            survival_threshold: 0.6,
            max_survivors: 3,
        }
    }
}

/// A labeled sample for evaluation.
#[derive(Debug, Clone)]
pub struct LabeledSample {
    pub content: String,
    pub is_attack: bool,
}

/// Result of affinity evaluation for a single candidate.
#[derive(Debug, Clone)]
pub struct AffinityResult {
    pub antibody: Antibody,
    pub true_positives: usize,
    pub false_positives: usize,
    pub true_negatives: usize,
    pub false_negatives: usize,
    pub affinity_score: f64,
    pub detected_must_detect: bool,
}

/// Affinity Maturation — evaluates antibody candidates against a validation set.
pub struct AffinityMaturation {
    config: AffinityConfig,
}

impl AffinityMaturation {
    pub fn new(config: AffinityConfig) -> Self {
        Self { config }
    }

    /// Evaluate candidates against a validation set.
    ///
    /// `must_detect` samples are attacks that MUST be detected (hard constraint).
    /// `should_detect` samples are similar attacks (soft constraint, improves recall).
    /// `must_not_detect` samples are benign (hard constraint, damages precision if flagged).
    pub fn evaluate(
        &self,
        candidates: Vec<Antibody>,
        must_detect: &[LabeledSample],
        should_detect: &[LabeledSample],
        must_not_detect: &[LabeledSample],
        // Scanner function: (antibody_prompt, content) -> (is_malicious, confidence)
        scanner: &dyn Fn(&str, &str) -> (bool, f64),
    ) -> Vec<AffinityResult> {
        let mut results = Vec::new();

        for mut candidate in candidates {
            let mut tp = 0usize;
            let mut fp = 0usize;
            let mut tn = 0usize;
            let mut fn_count = 0usize;

            // Test must-detect samples
            let mut detected_must = true;
            for sample in must_detect {
                let (flagged, _) = scanner(&candidate.prompt, &sample.content);
                if flagged {
                    tp += 1;
                } else {
                    fn_count += 1;
                    detected_must = false;
                }
            }

            // Test should-detect samples
            for sample in should_detect {
                let (flagged, _) = scanner(&candidate.prompt, &sample.content);
                if flagged {
                    tp += 1;
                } else {
                    fn_count += 1; // Still counts as FN for scoring
                }
            }

            // Test must-not-detect samples
            for sample in must_not_detect {
                let (flagged, _) = scanner(&candidate.prompt, &sample.content);
                if flagged {
                    fp += 1;
                } else {
                    tn += 1;
                }
            }

            // Compute affinity score
            let total_attacks = (must_detect.len() + should_detect.len()) as f64;
            let total_benign = must_not_detect.len() as f64;

            let recall = if total_attacks > 0.0 {
                tp as f64 / total_attacks
            } else {
                0.0
            };
            let precision = if (tp + fp) > 0 {
                tp as f64 / (tp + fp) as f64
            } else {
                0.0
            };
            let fp_rate = if total_benign > 0.0 {
                fp as f64 / total_benign
            } else {
                0.0
            };

            let affinity = recall * self.config.recall_weight
                + precision * self.config.precision_weight
                - fp_rate * self.config.fp_penalty;

            // Hard constraint: must detect all must-detect samples
            let final_score = if detected_must { affinity } else { 0.0 };

            candidate.affinity_score = final_score;

            results.push(AffinityResult {
                antibody: candidate,
                true_positives: tp,
                false_positives: fp,
                true_negatives: tn,
                false_negatives: fn_count,
                affinity_score: final_score,
                detected_must_detect: detected_must,
            });
        }

        // Sort by affinity descending
        results.sort_by(|a, b| {
            b.affinity_score
                .partial_cmp(&a.affinity_score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        info!(
            "Affinity maturation: {} candidates evaluated, best score={:.3}",
            results.len(),
            results.first().map(|r| r.affinity_score).unwrap_or(0.0)
        );

        results
    }

    /// Select survivors based on affinity scores.
    pub fn select_survivors(&self, results: Vec<AffinityResult>) -> Vec<Antibody> {
        results
            .into_iter()
            .filter(|r| r.affinity_score >= self.config.survival_threshold)
            .take(self.config.max_survivors)
            .map(|r| r.antibody)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::AntibodyStatus;

    fn make_candidate(id: &str) -> Antibody {
        Antibody {
            id: id.into(),
            name: format!("Candidate {}", id),
            description: "Test".into(),
            prompt: "Test prompt".into(),
            category: crate::core::AttackCategory::Injection,
            tier: crate::core::DefenseTier::Specialized,
            tools: vec![],
            memory_signatures: vec![],
            threshold: 0.7,
            generation: 1,
            parent_id: Some("parent".into()),
            affinity_score: 0.0,
            stats: Default::default(),
            status: AntibodyStatus::Candidate,
            created_at: chrono::Utc::now(),
            last_used_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn test_affinity_perfect_detector() {
        let maturation = AffinityMaturation::new(AffinityConfig::default());
        let candidates = vec![make_candidate("c1")];

        let must_detect = vec![
            LabeledSample { content: "DROP TABLE users".into(), is_attack: true },
        ];
        let should_detect = vec![];
        let must_not_detect = vec![
            LabeledSample { content: "Hello world".into(), is_attack: false },
        ];

        // Perfect scanner: always detects attack, never flags benign
        let scanner = |_prompt: &str, content: &str| -> (bool, f64) {
            (content.contains("DROP"), 0.95)
        };

        let results = maturation.evaluate(
            candidates,
            &must_detect,
            &should_detect,
            &must_not_detect,
            &scanner,
        );

        assert_eq!(results.len(), 1);
        assert!(results[0].affinity_score > 0.8);
        assert!(results[0].detected_must_detect);
    }

    #[test]
    fn test_affinity_false_positive_penalty() {
        let maturation = AffinityMaturation::new(AffinityConfig::default());
        let candidates = vec![make_candidate("c1")];

        let must_detect = vec![
            LabeledSample { content: "DROP TABLE users".into(), is_attack: true },
        ];
        let should_detect = vec![];
        let must_not_detect = vec![
            LabeledSample { content: "Hello world".into(), is_attack: false },
        ];

        // Over-eager scanner: flags everything
        let scanner = |_prompt: &str, _content: &str| -> (bool, f64) {
            (true, 0.9)
        };

        let results = maturation.evaluate(
            candidates,
            &must_detect,
            &should_detect,
            &must_not_detect,
            &scanner,
        );

        assert!(results[0].affinity_score < 0.8); // Penalized for FP
    }

    #[test]
    fn test_must_detect_hard_constraint() {
        let maturation = AffinityMaturation::new(AffinityConfig::default());
        let candidates = vec![make_candidate("c1")];

        let must_detect = vec![
            LabeledSample { content: "DROP TABLE users".into(), is_attack: true },
        ];
        let should_detect = vec![];
        let must_not_detect = vec![];

        // Scanner that misses the attack
        let scanner = |_prompt: &str, _content: &str| -> (bool, f64) {
            (false, 0.1)
        };

        let results = maturation.evaluate(
            candidates,
            &must_detect,
            &should_detect,
            &must_not_detect,
            &scanner,
        );

        assert_eq!(results[0].affinity_score, 0.0); // Hard fail
        assert!(!results[0].detected_must_detect);
    }

    #[test]
    fn test_select_survivors() {
        let config = AffinityConfig {
            max_survivors: 2,
            survival_threshold: 0.6,
            ..Default::default()
        };
        let maturation = AffinityMaturation::new(config);

        let results = vec![
            AffinityResult {
                antibody: make_candidate("best"),
                true_positives: 10,
                false_positives: 0,
                true_negatives: 10,
                false_negatives: 0,
                affinity_score: 0.95,
                detected_must_detect: true,
            },
            AffinityResult {
                antibody: make_candidate("good"),
                true_positives: 8,
                false_positives: 1,
                true_negatives: 9,
                false_negatives: 2,
                affinity_score: 0.75,
                detected_must_detect: true,
            },
            AffinityResult {
                antibody: make_candidate("bad"),
                true_positives: 5,
                false_positives: 5,
                true_negatives: 5,
                false_negatives: 5,
                affinity_score: 0.4,
                detected_must_detect: true,
            },
        ];

        let survivors = maturation.select_survivors(results);
        assert_eq!(survivors.len(), 2);
        assert_eq!(survivors[0].id, "best");
        assert_eq!(survivors[1].id, "good");
    }
}
