use std::sync::Arc;
use std::time::Duration;
use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use tower_http::cors::CorsLayer;
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::core::{ScanContext, Verdict};
use crate::llm::LlmProvider;
use crate::Caitlyn;

pub struct AppState {
    pub caitlyn: Arc<Caitlyn>,
    pub llm: Arc<dyn LlmProvider>,
}

pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/scan", post(scan))
        .route("/v1/antibodies", get(list_antibodies))
        .route("/v1/cost/stats", get(cost_stats))
        .route("/v1/status", get(status))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: String,
    service: String,
    version: String,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".into(),
        service: "caitlyn".into(),
        version: env!("CARGO_PKG_VERSION").into(),
    })
}

#[derive(Debug, Deserialize)]
struct ScanRequest {
    content: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    agent_task: Option<String>,
    #[serde(default)]
    mode: String, // "fast" | "full"
}

#[derive(Debug, Serialize)]
struct ScanResponse {
    verdict: String,
    confidence: f64,
    antibody_results: Vec<AntibodyResultResponse>,
    total_latency_us: u64,
    total_tokens: u64,
    triggered_vaccination: bool,
}

#[derive(Debug, Serialize)]
struct AntibodyResultResponse {
    antibody_id: String,
    antibody_name: String,
    verdict: String,
    confidence: f64,
    reasoning: String,
    tier: String,
}
async fn scan(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ScanRequest>,
) -> Result<Json<ScanResponse>, (StatusCode, String)> {
    let context = ScanContext {
        source: req.source,
        agent_task: req.agent_task,
        history_snippet: None,
        metadata: serde_json::json!({"mode": req.mode}),
    };

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        state
            .caitlyn
            .scan(&req.content, &context, Arc::clone(&state.llm)),
    )
    .await
    .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, "scan timed out after 30s".into()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(ScanResponse {
        verdict: match result.verdict {
            Verdict::Safe => "safe".into(),
            Verdict::Suspicious => "suspicious".into(),
            Verdict::Malicious => "malicious".into(),
        },
        confidence: result.confidence,
        antibody_results: result
            .antibody_results
            .iter()
            .map(|r| AntibodyResultResponse {
                antibody_id: r.antibody_id.clone(),
                antibody_name: r.antibody_name.clone(),
                verdict: match r.verdict {
                    Verdict::Safe => "safe".into(),
                    Verdict::Suspicious => "suspicious".into(),
                    Verdict::Malicious => "malicious".into(),
                },
                confidence: r.confidence,
                reasoning: r.reasoning.clone(),
                tier: r.tier.to_string(),
            })
            .collect(),
        total_latency_us: result.total_latency_us,
        total_tokens: result.total_tokens,
        triggered_vaccination: result.triggered_vaccination,
    }))
}

#[derive(Debug, Serialize)]
struct AntibodyResponse {
    id: String,
    name: String,
    description: String,
    category: String,
    tier: String,
    status: String,
    generation: u32,
    affinity_score: f64,
}

async fn list_antibodies(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<AntibodyResponse>> {
    let antibodies = state.caitlyn.antibody_pool.list(None, None).await;
    let response: Vec<_> = antibodies
        .iter()
        .map(|ab| AntibodyResponse {
            id: ab.id.clone(),
            name: ab.name.clone(),
            description: ab.description.clone(),
            category: format!("{:?}", ab.category).to_lowercase(),
            tier: ab.tier.to_string(),
            status: format!("{:?}", ab.status).to_lowercase(),
            generation: ab.generation,
            affinity_score: ab.affinity_score,
        })
        .collect();
    Json(response)
}

#[derive(Debug, Serialize)]
struct CostStatsResponse {
    tracked_patterns: usize,
    vaccinated_patterns: usize,
    patterns: Vec<serde_json::Value>,
}

async fn cost_stats(
    State(state): State<Arc<AppState>>,
) -> Json<CostStatsResponse> {
    let records = state.caitlyn.cost_monitor.list().await;
    let vaccinated = records.iter().filter(|r| r.vaccinated).count();
    let patterns: Vec<_> = records
        .iter()
        .map(|r| {
            serde_json::json!({
                "pattern_hash": &r.pattern_hash[..8],
                "category": format!("{:?}", r.category).to_lowercase(),
                "call_count": r.call_count,
                "avg_latency_us": r.avg_latency_us(),
                "avg_tokens": r.avg_tokens(),
                "success_rate": r.success_rate(),
                "vaccinated": r.vaccinated,
            })
        })
        .collect();

    Json(CostStatsResponse {
        tracked_patterns: records.len(),
        vaccinated_patterns: vaccinated,
        patterns,
    })
}

async fn status(
    State(state): State<Arc<AppState>>,
) -> Json<crate::CaitlynStatus> {
    Json(state.caitlyn.status().await)
}

/// Start the HTTP server.
pub async fn serve(caitlyn: Arc<Caitlyn>, llm: Arc<dyn LlmProvider>, port: u16) -> anyhow::Result<()> {
    let state = Arc::new(AppState {
        caitlyn,
        llm,
    });

    let app = build_router(state);
    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;

    info!("CAITLYN HTTP server listening on http://{}", addr);

    axum::serve(listener, app).await?;
    Ok(())
}
