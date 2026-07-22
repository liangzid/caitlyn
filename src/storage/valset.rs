//! Validation dataset loader for CAITLYN.
//!
//! Reads JSONL files from the valsets/ directory into
//! labeled samples for affinity maturation and benchmarking.

use std::path::Path;
use serde::Deserialize;
use tracing::info;

use crate::error::CaitlynResult;

/// A labeled sample from a validation dataset.
#[derive(Debug, Clone, Deserialize)]
pub struct DatasetEntry {
    pub id: String,
    pub content: String,
    pub source: String,
    #[serde(default)]
    pub attack_type: Option<String>,
    #[serde(default)]
    pub category: String,
}

/// Loaded validation dataset split by purpose.
#[derive(Debug, Clone)]
pub struct ValidationDataset {
    /// All attack samples
    pub attacks: Vec<DatasetEntry>,
    /// Benign/normal samples
    pub benign: Vec<DatasetEntry>,
    /// Edge cases (look suspicious but are safe)
    pub edge_cases: Vec<DatasetEntry>,
}

impl ValidationDataset {
    /// Load from the valsets/ directory.
    pub fn load(valset_dir: &str) -> CaitlynResult<Self> {
        let base = Path::new(valset_dir);

        let attacks = Self::load_jsonl_dir(&base.join("attacks"))?;
        let benign = Self::load_jsonl_dir(&base.join("benign"))?;
        let edge_cases = Self::load_jsonl_dir(&base.join("edge_cases"))?;

        info!(
            "Loaded validation dataset: {} attacks, {} benign, {} edge cases",
            attacks.len(),
            benign.len(),
            edge_cases.len()
        );

        Ok(Self {
            attacks,
            benign,
            edge_cases,
        })
    }

    fn load_jsonl_dir(dir: &Path) -> CaitlynResult<Vec<DatasetEntry>> {
        let mut entries = Vec::new();

        if !dir.exists() {
            return Ok(entries);
        }

        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();

            if path.extension().map_or(false, |e| e == "jsonl") {
                let content = std::fs::read_to_string(&path)?;
                for line in content.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<DatasetEntry>(line) {
                        Ok(entry) => entries.push(entry),
                        Err(e) => {
                            tracing::warn!(
                                "Failed to parse line in {:?}: {e}",
                                path.file_name()
                            );
                        }
                    }
                }
            }
        }

        Ok(entries)
    }

    /// Get attack content strings for scanning.
    pub fn attack_contents(&self) -> Vec<String> {
        self.attacks.iter().map(|e| e.content.clone()).collect()
    }

    /// Get benign content strings.
    pub fn benign_contents(&self) -> Vec<String> {
        self.benign.iter().map(|e| e.content.clone()).collect()
    }

    /// Split attacks by source.
    pub fn by_source(&self, source: &str) -> Vec<&DatasetEntry> {
        self.attacks
            .iter()
            .filter(|e| e.source == source)
            .collect()
    }

    /// Split attacks by category.
    pub fn by_category(&self, category: &str) -> Vec<&DatasetEntry> {
        self.attacks
            .iter()
            .filter(|e| e.category == category)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_validation_dataset() {
        let ds = ValidationDataset::load("./valsets").unwrap();
        println!(
            "Attacks: {}, Benign: {}",
            ds.attacks.len(),
            ds.benign.len()
        );
        assert!(ds.attacks.len() > 0, "Should have attack samples");
        assert!(ds.benign.len() > 0, "Should have benign samples");
    }

    #[test]
    fn test_by_source() {
        let ds = ValidationDataset::load("./valsets").unwrap();
        println!(
            "Attacks: {} entries, Benign: {} entries",
            ds.attacks.len(),
            ds.benign.len()
        );
        let agentdojo = ds.by_source("agentdojo");
        println!("AgentDojo attacks: {}", agentdojo.len());
        assert!(agentdojo.len() > 1000, "Should have many attack samples");
        assert!(ds.benign.len() >= 60, "Should have benign samples");
    }
}
