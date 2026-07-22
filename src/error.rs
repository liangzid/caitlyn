/// CAITLYN error types.
use thiserror::Error;

#[derive(Error, Debug)]
pub enum CaitlynError {
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Storage error: {0}")]
    Storage(#[from] sqlx::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(String),

    #[error("LLM provider error: {0}")]
    LlmProvider(String),

    #[error("Antibody not found: {0}")]
    AntibodyNotFound(String),

    #[error("Antibody validation failed: {0}")]
    AntibodyValidation(String),

    #[error("Evolution error: {0}")]
    Evolution(String),

    #[error("Vaccination error: {0}")]
    Vaccination(String),

    #[error("Scan error: {0}")]
    Scan(String),
}

impl From<serde_json::Error> for CaitlynError {
    fn from(e: serde_json::Error) -> Self {
        CaitlynError::Serialization(e.to_string())
    }
}

impl From<serde_yaml::Error> for CaitlynError {
    fn from(e: serde_yaml::Error) -> Self {
        CaitlynError::Serialization(e.to_string())
    }
}

pub type CaitlynResult<T> = Result<T, CaitlynError>;
