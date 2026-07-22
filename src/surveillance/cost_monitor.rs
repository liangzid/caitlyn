use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tokio::sync::RwLock;

use crate::core::AttackCategory;
use crate::config::VaccinationConfig;

/// Tracks defense cost per attack pattern.
/// Triggers vaccination when cost exceeds threshold.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostRecord {
    /// SHA256 hash of the normalized attack content
    pub pattern_hash: String,
    /// Representative sample of this pattern
    pub sample: String,
    /// Attack category
    pub category: AttackCategory,
    /// Which antibodies detected it
    pub resolved_by: Vec<String>,
    /// Cumulative stats
    pub call_count: u64,
    pub total_latency_us: u64,
    pub total_tokens: u64,
    pub success_count: u64,
    pub failure_count: u64,
    pub first_seen: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
    /// Has vaccination been triggered?
    pub vaccinated: bool,
    /// Resulting antibody ID if vaccinated
    pub vaccine_antibody_id: Option<String>,
}

impl CostRecord {
    pub fn avg_latency_us(&self) -> u64 {
        if self.call_count == 0 {
            0
        } else {
            self.total_latency_us / self.call_count
        }
    }

    pub fn avg_tokens(&self) -> u64 {
        if self.call_count == 0 {
            0
        } else {
            self.total_tokens / self.call_count
        }
    }

    pub fn success_rate(&self) -> f64 {
        if self.call_count == 0 {
            0.0
        } else {
            self.success_count as f64 / self.call_count as f64
        }
    }

    /// Check if vaccination should be triggered for this pattern.
    pub fn should_vaccinate(&self, config: &VaccinationConfig) -> bool {
        !self.vaccinated
            && self.call_count >= config.min_samples
            && self.success_rate() >= config.min_success_rate
            && (self.avg_latency_us() > config.latency_threshold_us
                || self.avg_tokens() > config.token_threshold)
    }
}

/// Thread-safe cost monitor.
pub struct CostMonitor {
    records: RwLock<HashMap<String, CostRecord>>,
    config: VaccinationConfig,
}

impl CostMonitor {
    pub fn new(config: VaccinationConfig) -> Self {
        Self {
            records: RwLock::new(HashMap::new()),
            config,
        }
    }

    /// Compute a pattern hash from content.
    /// Normalizes the content before hashing to group similar patterns.
    pub fn compute_pattern_hash(content: &str) -> String {
        let normalized = content
            .to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric() || c.is_whitespace())
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let mut hasher = Sha256::new();
        hasher.update(normalized.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    /// Record a scan result for cost tracking.
    pub async fn record(
        &self,
        pattern_hash: &str,
        sample: &str,
        category: AttackCategory,
        resolved_by: Vec<String>,
        success: bool,
        latency_us: u64,
        tokens: u64,
    ) {
        let mut records = self.records.write().await;
        let now = Utc::now();

        records
            .entry(pattern_hash.to_string())
            .and_modify(|r| {
                r.call_count += 1;
                r.total_latency_us += latency_us;
                r.total_tokens += tokens;
                if success {
                    r.success_count += 1;
                } else {
                    r.failure_count += 1;
                }
                r.last_seen = now;
                // Merge resolved_by
                for ab_id in &resolved_by {
                    if !r.resolved_by.contains(ab_id) {
                        r.resolved_by.push(ab_id.clone());
                    }
                }
            })
            .or_insert_with(|| CostRecord {
                pattern_hash: pattern_hash.to_string(),
                sample: sample.to_string(),
                category,
                resolved_by,
                call_count: 1,
                total_latency_us: latency_us,
                total_tokens: tokens,
                success_count: if success { 1 } else { 0 },
                failure_count: if success { 0 } else { 1 },
                first_seen: now,
                last_seen: now,
                vaccinated: false,
                vaccine_antibody_id: None,
            });
    }

    /// Check if any pattern needs vaccination.
    /// Returns list of patterns that should be vaccinated.
    pub async fn check_vaccination_triggers(&self) -> Vec<CostRecord> {
        let records = self.records.read().await;
        records
            .values()
            .filter(|r| r.should_vaccinate(&self.config))
            .cloned()
            .collect()
    }

    /// Mark a pattern as vaccinated.
    pub async fn mark_vaccinated(&self, pattern_hash: &str, antibody_id: &str) {
        let mut records = self.records.write().await;
        if let Some(record) = records.get_mut(pattern_hash) {
            record.vaccinated = true;
            record.vaccine_antibody_id = Some(antibody_id.to_string());
        }
    }

    /// Get a specific cost record.
    pub async fn get(&self, pattern_hash: &str) -> Option<CostRecord> {
        self.records.read().await.get(pattern_hash).cloned()
    }

    /// List all cost records.
    pub async fn list(&self) -> Vec<CostRecord> {
        self.records.read().await.values().cloned().collect()
    }

    /// Get total tracked patterns.
    pub async fn pattern_count(&self) -> usize {
        self.records.read().await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::VaccinationConfig;

    fn test_config() -> VaccinationConfig {
        VaccinationConfig {
            min_samples: 3,
            min_success_rate: 0.7,
            latency_threshold_us: 1_000_000, // 1 second
            token_threshold: 2000,
            shm_variants: 5,
            shm_base_temperature: 0.8,
            max_survivors: 2,
            affinity_recall_weight: 0.7,
            fp_tolerance: 0.05,
        }
    }

    #[tokio::test]
    async fn test_pattern_hash_consistent() {
        let h1 = CostMonitor::compute_pattern_hash("DROP TABLE users; SELECT * FROM data;");
        let h2 = CostMonitor::compute_pattern_hash("DROP TABLE users; SELECT * FROM data;");
        assert_eq!(h1, h2);
    }

    #[tokio::test]
    async fn test_pattern_hash_normalized() {
        let h1 = CostMonitor::compute_pattern_hash("DROP  TABLE   users;");
        let h2 = CostMonitor::compute_pattern_hash("drop table users");
        // Both normalize to "drop table users" (lowercase, single space)
        assert_eq!(h1, h2);
    }

    #[tokio::test]
    async fn test_should_vaccinate_triggers() {
        let config = test_config();
        let record = CostRecord {
            pattern_hash: "abc".into(),
            sample: "test".into(),
            category: AttackCategory::Injection,
            resolved_by: vec!["ab-1".into()],
            call_count: 5,
            total_latency_us: 10_000_000, // 10s total, avg 2s
            total_tokens: 0,
            success_count: 5,
            failure_count: 0,
            first_seen: Utc::now(),
            last_seen: Utc::now(),
            vaccinated: false,
            vaccine_antibody_id: None,
        };
        assert!(record.should_vaccinate(&config));
    }

    #[tokio::test]
    async fn test_should_not_vaccinate_below_threshold() {
        let config = test_config();
        let record = CostRecord {
            pattern_hash: "abc".into(),
            sample: "test".into(),
            category: AttackCategory::Injection,
            resolved_by: vec!["ab-1".into()],
            call_count: 2, // Below min_samples
            total_latency_us: 10_000_000,
            total_tokens: 0,
            success_count: 2,
            failure_count: 0,
            first_seen: Utc::now(),
            last_seen: Utc::now(),
            vaccinated: false,
            vaccine_antibody_id: None,
        };
        assert!(!record.should_vaccinate(&config));
    }

    #[tokio::test]
    async fn test_should_not_vaccinate_already_vaccinated() {
        let config = test_config();
        let record = CostRecord {
            pattern_hash: "abc".into(),
            sample: "test".into(),
            category: AttackCategory::Injection,
            resolved_by: vec!["ab-1".into()],
            call_count: 5,
            total_latency_us: 10_000_000,
            total_tokens: 0,
            success_count: 5,
            failure_count: 0,
            first_seen: Utc::now(),
            last_seen: Utc::now(),
            vaccinated: true, // Already vaccinated
            vaccine_antibody_id: Some("ab-vax".into()),
        };
        assert!(!record.should_vaccinate(&config));
    }
}
