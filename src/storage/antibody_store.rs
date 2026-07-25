use std::path::PathBuf;
use tracing::info;

use crate::core::{Antibody, AttackCategory, DefenseTier};
use crate::error::{CaitlynError, CaitlynResult};

/// Load antibodies from directory-based and flat YAML files.
pub async fn load_antibodies(antibody_dir: &str) -> CaitlynResult<Vec<Antibody>> {
    let dir = PathBuf::from(antibody_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut antibodies = Vec::new();

    // Walk the directory recursively
    let (skill_count, flat_count) = load_from_dir(&dir, &mut antibodies)?;

    info!(
        "Loaded {} antibodies from {} ({} skill dirs, {} flat YAMLs)",
        antibodies.len(),
        antibody_dir,
        skill_count,
        flat_count
    );
    Ok(antibodies)
}

fn load_from_dir(dir: &PathBuf, antibodies: &mut Vec<Antibody>) -> CaitlynResult<(usize, usize)> {
    let mut skill_count = 0;
    let mut flat_count = 0;

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            // Check if directory contains config.yaml or skill.yaml (new format)
            let config_yaml = path.join("config.yaml");
            let skill_yaml = path.join("skill.yaml");
            if config_yaml.exists() || skill_yaml.exists() {
                let yaml_path = if config_yaml.exists() { config_yaml } else { skill_yaml };
                match load_single_antibody(&yaml_path) {
                    Ok(ab) => {
                        antibodies.push(ab);
                        skill_count += 1;
                    }
                    Err(e) => {
                        tracing::warn!("Failed to load antibody from {:?}: {e}", yaml_path);
                    }
                }
            } else {
                // Recurse into subdirectories that don't have config/skill.yaml
                let (sub_skill, sub_flat) = load_from_dir(&path, antibodies)?;
                skill_count += sub_skill;
                flat_count += sub_flat;
            }
        } else if path.extension().map_or(false, |e| e == "yaml" || e == "yml") {
            // Old format: flat YAML file (backward compat)
            match load_single_antibody(&path) {
                Ok(ab) => {
                    antibodies.push(ab);
                    flat_count += 1;
                }
                Err(e) => {
                    tracing::warn!("Failed to load antibody from {:?}: {e}", path);
                }
            }
        }
    }
    Ok((skill_count, flat_count))
}

fn load_single_antibody(path: &PathBuf) -> CaitlynResult<Antibody> {
    let content = std::fs::read_to_string(path)?;
    let antibody: AntibodyFile = serde_yaml::from_str(&content)
        .map_err(|e| CaitlynError::Serialization(format!("Failed to parse {:?}: {e}", path)))?;
    Ok(antibody.into())
}

/// Save an antibody to a YAML file.
pub async fn save_antibody(
    antibody: &Antibody,
    antibody_dir: &str,
    subdir: &str,
) -> CaitlynResult<PathBuf> {
    let dir = PathBuf::from(antibody_dir).join(subdir);
    std::fs::create_dir_all(&dir)?;

    let filename = format!("{}.yaml", antibody.id);
    let path = dir.join(&filename);

    let file_repr: AntibodyFile = antibody.into();
    let yaml = serde_yaml::to_string(&file_repr)
        .map_err(|e| CaitlynError::Serialization(format!("Failed to serialize antibody: {e}")))?;

    std::fs::write(&path, yaml)?;
    info!("Saved antibody {} to {:?}", antibody.id, path);
    Ok(path)
}

/// YAML file representation of an antibody.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct AntibodyFile {
    id: String,
    name: String,
    description: String,
    prompt: String,
    category: String,
    tier: u8,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    #[serde(alias = "memory_signatures")]
    signatures: Vec<SignatureFile>,
    threshold: f64,
    #[serde(default)]
    generation: u32,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    affinity_score: f64,
    #[serde(default)]
    deps: Vec<String>,
}
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct SignatureFile {
    pattern: String,
    #[serde(rename = "type")]
    sig_type: String,
    #[serde(default)]
    label: Option<String>,
}

impl From<&Antibody> for AntibodyFile {
    fn from(ab: &Antibody) -> Self {
        AntibodyFile {
            id: ab.id.clone(),
            name: ab.name.clone(),
            description: ab.description.clone(),
            prompt: ab.prompt.clone(),
            category: match ab.category {
                AttackCategory::Injection => "injection",
                AttackCategory::Poisoning => "poisoning",
                AttackCategory::Jailbreak => "jailbreak",
                AttackCategory::DataExfiltration => "exfil",
                AttackCategory::ToolMisuse => "tool_misuse",
                AttackCategory::Unknown => "unknown",
            }
            .to_string(),
            tier: ab.tier as u8,
            tools: ab.tools.clone(),
            signatures: ab
                .memory_signatures
                .iter()
                .map(|s| SignatureFile {
                    pattern: s.pattern.clone(),
                    sig_type: match s.sig_type {
                        crate::core::SignatureType::Exact => "exact",
                        crate::core::SignatureType::Regex => "regex",
                        crate::core::SignatureType::Semantic => "semantic",
                    }
                    .to_string(),
                    label: s.label.clone(),
                })
                .collect(),
            threshold: ab.threshold,
            generation: ab.generation,
            parent_id: ab.parent_id.clone(),
            affinity_score: ab.affinity_score,
            deps: ab.deps.clone(),
        }
    }
}

impl From<AntibodyFile> for Antibody {
    fn from(f: AntibodyFile) -> Self {
        Antibody {
            id: f.id,
            name: f.name,
            description: f.description,
            prompt: f.prompt,
            category: match f.category.as_str() {
                "poisoning" => AttackCategory::Poisoning,
                "jailbreak" => AttackCategory::Jailbreak,
                "exfil" => AttackCategory::DataExfiltration,
                "tool_misuse" => AttackCategory::ToolMisuse,
                "unknown" => AttackCategory::Unknown,
                _ => AttackCategory::Injection,
            },
            tier: match f.tier {
                0 => DefenseTier::Signature,
                1 => DefenseTier::Specialized,
                3 => DefenseTier::Deep,
                _ => DefenseTier::General,
            },
            tools: f.tools,
            memory_signatures: f
                .signatures
                .into_iter()
                .map(|s| crate::core::Signature {
                    pattern: s.pattern,
                    sig_type: match s.sig_type.as_str() {
                        "regex" => crate::core::SignatureType::Regex,
                        "semantic" => crate::core::SignatureType::Semantic,
                        _ => crate::core::SignatureType::Exact,
                    },
                    label: s.label,
                })
                .collect(),
            threshold: f.threshold,
            generation: f.generation,
            parent_id: f.parent_id,
            affinity_score: f.affinity_score,
            deps: f.deps,
            stats: Default::default(),
            status: crate::core::AntibodyStatus::Active,
            created_at: chrono::Utc::now(),
            last_used_at: chrono::Utc::now(),
        }
    }
}
