use std::collections::HashMap;
use tokio::sync::RwLock;

use super::models::{Antibody, AntibodyStatus, DefenseTier};
use crate::error::{CaitlynError, CaitlynResult};

/// Thread-safe antibody pool managing all defense skills.
pub struct AntibodyPool {
    antibodies: RwLock<HashMap<String, Antibody>>,
}

impl AntibodyPool {
    pub fn new() -> Self {
        Self {
            antibodies: RwLock::new(HashMap::new()),
        }
    }

    /// Add an antibody to the pool.
    pub async fn add(&self, antibody: Antibody) -> CaitlynResult<()> {
        let mut pool = self.antibodies.write().await;
        if pool.contains_key(&antibody.id) {
            return Err(CaitlynError::AntibodyValidation(format!(
                "Antibody with id '{}' already exists",
                antibody.id
            )));
        }
        pool.insert(antibody.id.clone(), antibody);
        Ok(())
    }

    /// Remove an antibody by id.
    pub async fn remove(&self, id: &str) -> CaitlynResult<Antibody> {
        let mut pool = self.antibodies.write().await;
        pool.remove(id)
            .ok_or_else(|| CaitlynError::AntibodyNotFound(id.to_string()))
    }

    /// Get an antibody by id.
    pub async fn get(&self, id: &str) -> CaitlynResult<Antibody> {
        let pool = self.antibodies.read().await;
        pool.get(id)
            .cloned()
            .ok_or_else(|| CaitlynError::AntibodyNotFound(id.to_string()))
    }

    /// Get all active antibodies of a given tier (or all tiers if None).
    pub async fn get_active(&self, tier: Option<DefenseTier>) -> Vec<Antibody> {
        let pool = self.antibodies.read().await;
        pool.values()
            .filter(|ab| ab.status == AntibodyStatus::Active)
            .filter(|ab| tier.map_or(true, |t| ab.tier == t))
            .cloned()
            .collect()
    }

    /// Get all antibodies with optional status and tier filters.
    pub async fn list(
        &self,
        status: Option<AntibodyStatus>,
        tier: Option<DefenseTier>,
    ) -> Vec<Antibody> {
        let pool = self.antibodies.read().await;
        pool.values()
            .filter(|ab| status.as_ref().map_or(true, |s| ab.status == *s))
            .filter(|ab| tier.map_or(true, |t| ab.tier == t))
            .cloned()
            .collect()
    }

    /// Suppress an antibody (temporarily disable due to high FP).
    pub async fn suppress(&self, id: &str) -> CaitlynResult<()> {
        let mut pool = self.antibodies.write().await;
        let ab = pool
            .get_mut(id)
            .ok_or_else(|| CaitlynError::AntibodyNotFound(id.to_string()))?;
        ab.status = AntibodyStatus::Suppressed;
        Ok(())
    }

    /// Retire an antibody permanently.
    pub async fn retire(&self, id: &str) -> CaitlynResult<()> {
        let mut pool = self.antibodies.write().await;
        let ab = pool
            .get_mut(id)
            .ok_or_else(|| CaitlynError::AntibodyNotFound(id.to_string()))?;
        ab.status = AntibodyStatus::Retired;
        Ok(())
    }

    /// Activate a suppressed or candidate antibody.
    pub async fn activate(&self, id: &str) -> CaitlynResult<()> {
        let mut pool = self.antibodies.write().await;
        let ab = pool
            .get_mut(id)
            .ok_or_else(|| CaitlynError::AntibodyNotFound(id.to_string()))?;
        ab.status = AntibodyStatus::Active;
        Ok(())
    }

    /// Update an antibody's stats after a scan.
    pub async fn update_stats(
        &self,
        id: &str,
        true_positive: bool,
        false_positive: bool,
        latency_us: u64,
        tokens: u64,
    ) -> CaitlynResult<()> {
        let mut pool = self.antibodies.write().await;
        let ab = pool
            .get_mut(id)
            .ok_or_else(|| CaitlynError::AntibodyNotFound(id.to_string()))?;

        if true_positive {
            ab.stats.true_positives += 1;
        }
        if false_positive {
            ab.stats.false_positives += 1;
        }
        ab.stats.total_scans += 1;

        // Exponential moving average for latency and tokens
        if ab.stats.total_scans == 1 {
            ab.stats.avg_latency_us = latency_us;
            ab.stats.avg_tokens = tokens;
        } else {
            let alpha = 0.1;
            ab.stats.avg_latency_us =
                ((1.0 - alpha) * ab.stats.avg_latency_us as f64 + alpha * latency_us as f64) as u64;
            ab.stats.avg_tokens =
                ((1.0 - alpha) * ab.stats.avg_tokens as f64 + alpha * tokens as f64) as u64;
        }

        Ok(())
    }

    /// Count antibodies by status.
    pub async fn count_by_status(&self) -> HashMap<AntibodyStatus, usize> {
        let pool = self.antibodies.read().await;
        let mut counts = HashMap::new();
        for ab in pool.values() {
            *counts.entry(ab.status.clone()).or_insert(0) += 1;
        }
        counts
    }

    /// Get total antibody count.
    pub async fn len(&self) -> usize {
        self.antibodies.read().await.len()
    }
}

impl Default for AntibodyPool {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn make_test_antibody(id: &str, tier: DefenseTier) -> Antibody {
        Antibody {
            id: id.to_string(),
            name: format!("Test {}", id),
            description: "Test antibody".into(),
            prompt: "You are a test antibody.".into(),
            category: crate::core::AttackCategory::Injection,
            tier,
            tools: vec![],
            memory_signatures: vec![],
            threshold: 0.7,
            generation: 0,
            parent_id: None,
            affinity_score: 0.0,
            stats: Default::default(),
            status: AntibodyStatus::Active,
            created_at: Utc::now(),
            last_used_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn test_add_and_get() {
        let pool = AntibodyPool::new();
        let ab = make_test_antibody("ab-1", DefenseTier::General);
        pool.add(ab.clone()).await.unwrap();
        let retrieved = pool.get("ab-1").await.unwrap();
        assert_eq!(retrieved.id, "ab-1");
        assert_eq!(retrieved.name, "Test ab-1");
    }

    #[tokio::test]
    async fn test_duplicate_add_fails() {
        let pool = AntibodyPool::new();
        let ab = make_test_antibody("ab-1", DefenseTier::General);
        pool.add(ab.clone()).await.unwrap();
        assert!(pool.add(ab).await.is_err());
    }

    #[tokio::test]
    async fn test_filter_by_tier() {
        let pool = AntibodyPool::new();
        pool.add(make_test_antibody("ab-1", DefenseTier::General))
            .await
            .unwrap();
        pool.add(make_test_antibody("ab-2", DefenseTier::Specialized))
            .await
            .unwrap();
        pool.add(make_test_antibody("ab-3", DefenseTier::General))
            .await
            .unwrap();

        let specialized = pool.get_active(Some(DefenseTier::Specialized)).await;
        assert_eq!(specialized.len(), 1);
        assert_eq!(specialized[0].id, "ab-2");

        let general = pool.get_active(Some(DefenseTier::General)).await;
        assert_eq!(general.len(), 2);
    }

    #[tokio::test]
    async fn test_suppress_and_activate() {
        let pool = AntibodyPool::new();
        pool.add(make_test_antibody("ab-1", DefenseTier::General))
            .await
            .unwrap();

        pool.suppress("ab-1").await.unwrap();
        let ab = pool.get("ab-1").await.unwrap();
        assert_eq!(ab.status, AntibodyStatus::Suppressed);

        // Should not appear in active
        assert!(pool.get_active(None).await.is_empty());

        pool.activate("ab-1").await.unwrap();
        let ab = pool.get("ab-1").await.unwrap();
        assert_eq!(ab.status, AntibodyStatus::Active);
    }
}
