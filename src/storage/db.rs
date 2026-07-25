use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;
use tracing::info;

use crate::config::StorageConfig;
use crate::error::{CaitlynError, CaitlynResult};

/// Initialize the SQLite database with schema.
pub async fn init_db(config: &StorageConfig) -> CaitlynResult<SqlitePool> {
    let options = SqliteConnectOptions::from_str(&config.db_path)
        .map_err(|e| CaitlynError::Config(format!("Invalid DB path: {e}")))?
        .create_if_missing(true)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    run_migrations(&pool).await?;

    info!("Database initialized at {}", config.db_path);
    Ok(pool)
}

async fn run_migrations(pool: &SqlitePool) -> CaitlynResult<()> {
    // Schema versioning
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT DEFAULT (datetime('now'))
        )"
    ).execute(pool).await?;

    let current: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version"
    ).fetch_one(pool).await?;

    if current < 1 {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS memory_entries (
                id TEXT PRIMARY KEY,
                signature TEXT NOT NULL,
                signature_type TEXT NOT NULL CHECK(signature_type IN ('exact','regex','semantic')),
                antibody_id TEXT NOT NULL,
                antigen_id TEXT,
                category TEXT NOT NULL,
                hit_count INTEGER DEFAULT 0,
                last_hit TEXT,
                embedding BLOB,
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_memory_antibody ON memory_entries(antibody_id);
            CREATE INDEX IF NOT EXISTS idx_memory_category ON memory_entries(category);

            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
                signature,
                content='memory_entries',
                content_rowid='rowid'
            );

            -- FTS sync triggers
            CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_entries BEGIN
                INSERT INTO memory_fts(rowid, signature) VALUES (new.rowid, new.signature);
            END;

            CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_entries BEGIN
                INSERT INTO memory_fts(memory_fts, rowid, signature) VALUES ('delete', old.rowid, old.signature);
            END;

            CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memory_entries BEGIN
                INSERT INTO memory_fts(memory_fts, rowid, signature) VALUES ('delete', old.rowid, old.signature);
                INSERT INTO memory_fts(rowid, signature) VALUES (new.rowid, new.signature);
            END;
            "#
        ).execute(pool).await?;

        sqlx::query("INSERT INTO schema_version (version) VALUES (1)").execute(pool).await?;
    }

    if current < 2 {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS antibody_stats (
                antibody_id TEXT PRIMARY KEY,
                true_positives INTEGER DEFAULT 0,
                false_positives INTEGER DEFAULT 0,
                true_negatives INTEGER DEFAULT 0,
                false_negatives INTEGER DEFAULT 0,
                total_scans INTEGER DEFAULT 0,
                avg_latency_us INTEGER DEFAULT 0,
                avg_tokens INTEGER DEFAULT 0,
                affinity_score REAL DEFAULT 0.0,
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS cost_records (
                pattern_hash TEXT PRIMARY KEY,
                sample TEXT NOT NULL,
                category TEXT NOT NULL,
                resolved_by TEXT NOT NULL,
                call_count INTEGER DEFAULT 0,
                total_latency_us INTEGER DEFAULT 0,
                total_tokens INTEGER DEFAULT 0,
                success_count INTEGER DEFAULT 0,
                failure_count INTEGER DEFAULT 0,
                first_seen TEXT,
                last_seen TEXT,
                vaccinated INTEGER DEFAULT 0,
                vaccine_antibody_id TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS evolution_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pattern_hash TEXT NOT NULL,
                parent_antibody_id TEXT,
                child_antibody_ids TEXT,
                shm_temperature REAL,
                survivors_count INTEGER,
                best_affinity REAL,
                total_latency_ms INTEGER,
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS antigens (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                source_type TEXT NOT NULL,
                category TEXT NOT NULL,
                escaped_antibodies TEXT,
                resolved_by TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_cost_category ON cost_records(category);
            CREATE INDEX IF NOT EXISTS idx_antigen_category ON antigens(category);
            "#
        ).execute(pool).await?;

        sqlx::query("INSERT INTO schema_version (version) VALUES (2)").execute(pool).await?;
    }

    info!("Database migrations complete (v{})", current.max(2));
    Ok(())
}
/// Persist a memory entry to the database.
pub async fn insert_memory_entry(pool: &SqlitePool, entry: &crate::core::MemoryEntry) -> CaitlynResult<()> {
    sqlx::query(
        r#"
        INSERT OR REPLACE INTO memory_entries (id, signature, signature_type, antibody_id, antigen_id, category, hit_count, last_hit, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&entry.id)
    .bind(&entry.signature)
    .bind(match entry.signature_type {
        crate::core::SignatureType::Exact => "exact",
        crate::core::SignatureType::Regex => "regex",
        crate::core::SignatureType::Semantic => "semantic",
    })
    .bind(&entry.antibody_id)
    .bind(&entry.antigen_id)
    .bind(match entry.category {
        crate::core::AttackCategory::Injection => "injection",
        crate::core::AttackCategory::Poisoning => "poisoning",
        crate::core::AttackCategory::Jailbreak => "jailbreak",
        crate::core::AttackCategory::DataExfiltration => "exfil",
        crate::core::AttackCategory::ToolMisuse => "tool_misuse",
        crate::core::AttackCategory::Unknown => "unknown",
    })
    .bind(entry.hit_count as i64)
    .bind(entry.last_hit.to_rfc3339())
    .bind(entry.embedding.as_ref().map(|e| {
        // Serialize embedding to bytes (simple f32 array)
        let bytes: Vec<u8> = e.iter().flat_map(|f| f.to_le_bytes()).collect();
        bytes
    }))
    .execute(pool)
    .await?;
    Ok(())
}

/// Load all memory entries from the database.
pub async fn load_memory_entries(pool: &SqlitePool) -> CaitlynResult<Vec<crate::core::MemoryEntry>> {
    let rows = sqlx::query_as::<_, MemoryEntryRow>(
        r#"SELECT id, signature, signature_type, antibody_id, antigen_id, category, hit_count, last_hit, embedding FROM memory_entries"#,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|r| r.into()).collect())
}

// Row type for SQLx queries
#[derive(sqlx::FromRow)]
struct MemoryEntryRow {
    id: String,
    signature: String,
    signature_type: String,
    antibody_id: String,
    antigen_id: Option<String>,
    category: String,
    hit_count: i64,
    last_hit: Option<String>,
    embedding: Option<Vec<u8>>,
}

impl From<MemoryEntryRow> for crate::core::MemoryEntry {
    fn from(row: MemoryEntryRow) -> Self {
        use chrono::DateTime;
        crate::core::MemoryEntry {
            id: row.id,
            signature: row.signature,
            signature_type: match row.signature_type.as_str() {
                "regex" => crate::core::SignatureType::Regex,
                "semantic" => crate::core::SignatureType::Semantic,
                _ => crate::core::SignatureType::Exact,
            },
            antibody_id: row.antibody_id,
            antigen_id: row.antigen_id.unwrap_or_default(),
            category: match row.category.as_str() {
                "poisoning" => crate::core::AttackCategory::Poisoning,
                "jailbreak" => crate::core::AttackCategory::Jailbreak,
                "exfil" => crate::core::AttackCategory::DataExfiltration,
                "tool_misuse" => crate::core::AttackCategory::ToolMisuse,
                "unknown" => crate::core::AttackCategory::Unknown,
                _ => crate::core::AttackCategory::Injection,
            },
            hit_count: row.hit_count as u64,
            last_hit: row
                .last_hit
                .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(chrono::Utc::now),
            embedding: row.embedding.map(|bytes| {
                bytes
                    .chunks_exact(4)
                    .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                    .collect()
            }),
        }
    }
}

/// Persist a cost record to the database.
pub async fn upsert_cost_record(
    pool: &SqlitePool,
    record: &crate::surveillance::cost_monitor::CostRecord,
) -> CaitlynResult<()> {
    let resolved_by_json = serde_json::to_string(&record.resolved_by).unwrap_or_default();
    sqlx::query(
        r#"
        INSERT OR REPLACE INTO cost_records
        (pattern_hash, sample, category, resolved_by, call_count, total_latency_us, total_tokens,
         success_count, failure_count, first_seen, last_seen, vaccinated, vaccine_antibody_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&record.pattern_hash)
    .bind(&record.sample)
    .bind(match record.category {
        crate::core::AttackCategory::Injection => "injection",
        crate::core::AttackCategory::Poisoning => "poisoning",
        crate::core::AttackCategory::Jailbreak => "jailbreak",
        crate::core::AttackCategory::DataExfiltration => "exfil",
        crate::core::AttackCategory::ToolMisuse => "tool_misuse",
        crate::core::AttackCategory::Unknown => "unknown",
    })
    .bind(&resolved_by_json)
    .bind(record.call_count as i64)
    .bind(record.total_latency_us as i64)
    .bind(record.total_tokens as i64)
    .bind(record.success_count as i64)
    .bind(record.failure_count as i64)
    .bind(record.first_seen.to_rfc3339())
    .bind(record.last_seen.to_rfc3339())
    .bind(if record.vaccinated { 1 } else { 0 })
    .bind(&record.vaccine_antibody_id)
    .execute(pool)
    .await?;
    Ok(())
}
