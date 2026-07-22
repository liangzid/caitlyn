# CAITLYN: Revised Design Document v2

## 0. Conceptual Model (Updated)

### The Immunization Analogy (Refined)

```
生物免疫                           CAITLYN
──────────────────────────────────────────────────────────
先天免疫 (Innate)         →    Builtin General Antibodies
                              (broad, expensive, always present)

初次感染 + 发热            →    First encounter: expensive defense
                              (Tier 2/3 reasoning, multi-hop, high latency)

疫苗接种 (Vaccination)     →    Cost-triggered evolution
                              (observed pattern: defense cost > threshold)

适应性免疫 (Adaptive)      →    Evolved Specialized Antibodies
                              (Tier 1, cheap, fast, pattern-specific)

免疫记忆 (Memory)         →    Memory Bank (signature fast-path)
```

### Key Insight

CAITLYN does NOT wait for an attack to be "labeled" by a human. Instead:

1. CAITLYN is **always scanning** — every piece of external content passes through
2. Builtin antibodies (Tier 2/3) are **general but expensive** — they catch attacks but at high cost
3. The **Cost Monitor** tracks: latency, token usage, success rate per attack pattern
4. When cost > threshold AND pattern recurs > N times → **Vaccination Trigger**
5. Vaccination produces a **specialized Tier 1 antibody** that handles this pattern cheaply
6. The specialized antibody is validated (affinity maturation) and deployed

## 1. Architecture

### 1.1 Deployment Topology

```
┌─────────────────────────────────────────────────────────────┐
│                     CAITLYN DAEMON                              │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────┐  │
│  │   HTTP API        │  │   MCP Server     │  │  gRPC     │  │
│  │  (REST + SSE)     │  │  (stdio/sse)     │  │ (internal)│  │
│  └────────┬─────────┘  └────────┬─────────┘  └─────┬─────┘  │
│           │                     │                   │        │
│           └─────────────────────┼───────────────────┘        │
│                                 │                            │
│                    ┌────────────▼────────────┐               │
│                    │    SURVEILLANCE LOOP     │               │
│                    │  (continuous, async)     │               │
│                    └────────────┬────────────┘               │
│                                 │                            │
│           ┌─────────────────────┼─────────────────────┐      │
│           │                     │                     │      │
│  ┌────────▼────────┐  ┌────────▼────────┐  ┌─────────▼───┐  │
│  │  Memory Bank    │  │ Antibody Pool   │  │Cost Monitor │  │
│  │  (FTS5 + Vec)   │  │ (Tier 0/1/2/3) │  │(per-pattern)│  │
│  └─────────────────┘  └────────┬────────┘  └──────┬──────┘  │
│                                │                   │        │
│                     ┌──────────▼───────────────────▼──┐      │
│                     │      EVOLUTION ENGINE            │      │
│                     │  ┌──────────┐ ┌──────────────┐  │      │
│                     │  │   SHM    │ │  Affinity    │  │      │
│                     │  │  Engine  │ │  Maturation  │  │      │
│                     │  └──────────┘ └──────────────┘  │      │
│                     └─────────────────────────────────┘      │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                    STORAGE LAYER                       │   │
│  │  SQLite (FTS5):  memory, stats, evolution_log         │   │
│  │  Filesystem:     antibodies/ (YAML), config.toml       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Three Integration Modes

```
MODE A: STANDALONE DAEMON
  Agent Framework ──HTTP──▶ CAITLYN (:9070)
  Direct REST API + SSE streaming

MODE B: MCP SERVER
  Coding Agent ──MCP──▶ CAITLYN (stdio or SSE)
  Agent calls caitlyn.scan as a tool

MODE C: EMBEDDED LIBRARY
  Rust Agent ──crate──▶ caitlyn_core
  Direct function calls, no network overhead
```

### 1.3 Project Structure

```
caitlyn/
├── Cargo.toml
├── Cargo.lock
├── config.toml                    # Default configuration
├── antibodies/                    # Builtin antibodies
│   ├── injection_general.yaml
│   ├── jailbreak_general.yaml
│   ├── poisoning_general.yaml
│   └── exfil_general.yaml
├── src/
│   ├── main.rs                    # Daemon entry point
│   ├── lib.rs                     # Library entry point
│   ├── config.rs                  # Configuration
│   │
│   ├── core/
│   │   ├── mod.rs
│   │   ├── antibody.rs            # Antibody struct + pool
│   │   ├── antigen.rs             # Attack sample struct
│   │   ├── memory.rs              # MemoryBank: signature + semantic
│   │   ├── verdict.rs             # Verdict, ScanResult types
│   │   └── tier.rs                # Defense tier definitions
│   │
│   ├── surveillance/
│   │   ├── mod.rs
│   │   ├── scanner.rs             # ContentScanner: run antibodies
│   │   ├── aggregator.rs          # Vote aggregation
│   │   └── cost_monitor.rs        # Per-pattern cost tracking
│   │
│   ├── evolution/
│   │   ├── mod.rs
│   │   ├── trigger.rs             # Vaccination trigger logic
│   │   ├── shm.rs                 # Somatic Hypermutation
│   │   ├── affinity.rs            # Affinity Maturation
│   │   └── selection.rs           # Clonal Selection
│   │
│   ├── storage/
│   │   ├── mod.rs
│   │   ├── db.rs                  # SQLite (FTS5) operations
│   │   ├── antibody_store.rs      # YAML persistence
│   │   └── valset_store.rs        # Validation set management
│   │
│   ├── server/
│   │   ├── mod.rs
│   │   ├── http.rs                # REST API + SSE
│   │   ├── mcp.rs                 # MCP Server implementation
│   │   └── grpc.rs                # gRPC (future)
│   │
│   └── llm/
│       ├── mod.rs
│       ├── provider.rs            # LLM provider trait
│       ├── deepseek.rs            # DeepSeek provider
│       ├── openai.rs              # OpenAI provider
│       └── anthropic.rs           # Anthropic provider
│
├── tests/
│   ├── integration/
│   │   ├── test_surveillance.rs
│   │   ├── test_evolution.rs
│   │   └── test_mcp.rs
│   └── unit/
│       ├── test_antibody.rs
│       ├── test_memory.rs
│       └── test_cost_monitor.rs
│
├── benches/
│   └── scan_benchmark.rs
│
└── valsets/                       # Validation datasets
    ├── attacks/
    │   ├── injections.jsonl
    │   ├── jailbreaks.jsonl
    │   └── poisonings.jsonl
    ├── benign/
    │   └── normal_queries.jsonl
    └── edge_cases/
        └── adversarial_benign.jsonl
```

## 2. Data Models

### 2.1 Antibody (Defense Skill)

```rust
/// Defense tier — determines cost and capability.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DefenseTier {
    /// Tier 0: Memory fast-path (microseconds)
    Signature,
    /// Tier 1: Specialized antibody, single LLM call, no tools (~100ms)
    Specialized,
    /// Tier 2: General antibody, single LLM call with optional tools (~500ms)
    General,
    /// Tier 3: Deep analysis, multi-step LLM with tool calls (~2-5s)
    Deep,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AntibodyStatus {
    Active,
    Suppressed,  // High FP, temporarily disabled
    Retired,     // Permanently removed
    Candidate,   // Newly generated, under evaluation
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AntibodyStats {
    pub true_positives: u64,
    pub false_positives: u64,
    pub true_negatives: u64,
    pub false_negatives: u64,
    pub total_scans: u64,
    pub avg_latency_us: u64,    // Microseconds
    pub avg_tokens: u64,        // Average token cost per scan
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Antibody {
    pub id: String,
    pub name: String,
    pub description: String,
    pub prompt: String,              // System prompt for LLM scanning
    pub category: AttackCategory,
    pub tier: DefenseTier,
    pub tools: Vec<String>,          // Optional verification tools
    pub memory_signatures: Vec<Signature>,
    pub threshold: f64,              // Confidence threshold (0.0-1.0)
    pub generation: u32,             // SHM generation number
    pub parent_id: Option<String>,   // Lineage tracking
    pub affinity_score: f64,         // Current performance on validation
    pub stats: AntibodyStats,
    pub status: AntibodyStatus,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signature {
    pub pattern: String,
    pub sig_type: SignatureType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SignatureType {
    Exact,
    Regex,
    Semantic,   // Embedding-based
}
```

### 2.2 Cost Monitor Entry

```rust
/// Tracks defense cost per attack pattern.
/// Triggers vaccination when cost exceeds threshold.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostRecord {
    /// Hash of the attack pattern (normalized content)
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
    pub success_count: u64,     // Correct identifications
    pub failure_count: u64,     // Missed detections
    pub first_seen: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
    /// Has vaccination been triggered for this pattern?
    pub vaccinated: bool,
    /// Resulting antibody ID if vaccinated
    pub vaccine_antibody_id: Option<String>,
}

impl CostRecord {
    pub fn avg_latency_us(&self) -> u64 {
        if self.call_count == 0 { 0 } else { self.total_latency_us / self.call_count }
    }

    pub fn avg_tokens(&self) -> u64 {
        if self.call_count == 0 { 0 } else { self.total_tokens / self.call_count }
    }

    pub fn success_rate(&self) -> f64 {
        if self.call_count == 0 { 0.0 }
        else { self.success_count as f64 / self.call_count as f64 }
    }

    /// Check if vaccination should be triggered.
    pub fn should_vaccinate(&self, config: &VaccinationConfig) -> bool {
        !self.vaccinated
            && self.call_count >= config.min_samples
            && self.success_rate() >= config.min_success_rate
            && (self.avg_latency_us() > config.latency_threshold_us
                || self.avg_tokens() > config.token_threshold)
    }
}
```

### 2.3 Scan Result

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Verdict {
    Safe,
    Suspicious,
    Malicious,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AntibodyResult {
    pub antibody_id: String,
    pub antibody_name: String,
    pub verdict: Verdict,
    pub confidence: f64,
    pub reasoning: String,
    pub matched_signatures: Vec<String>,
    pub tier: DefenseTier,
    pub latency_us: u64,
    pub tokens_used: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub verdict: Verdict,
    pub confidence: f64,
    pub antibody_results: Vec<AntibodyResult>,
    pub matched_memory: Vec<MemoryEntry>,
    pub total_latency_us: u64,
    pub total_tokens: u64,
    pub triggered_vaccination: bool,
}
```

## 3. Core Algorithms (Revised)

### 3.1 Surveillance Loop

```
Algorithm: scan(content, context) → ScanResult

1. PREPROCESS
   - Normalize content
   - Compute content_hash for pattern tracking
   - Extract structural features (URLs, code blocks, etc.)

2. TIER 0: MEMORY FAST-PATH (~µs)
   For each MemoryEntry:
     match signature_type:
       Exact   → content.contains(signature)
       Regex   → regex.is_match(content)
       Semantic → cosine_sim(embed(content), entry.embedding) > 0.95
   If match → return MALICIOUS immediately
   // This is the "immune memory" response — instant

3. TIER 1: SPECIALIZED ANTIBODIES (parallel, ~100ms each)
   For each Active antibody where tier = Specialized:
     result = llm_scan(antibody.prompt, content, context)
     // Single LLM call, no tools, small model possible

4. EARLY EXIT CHECK
   If any Tier 1 result is MALICIOUS with confidence > 0.9:
     record_cost(content_hash, result)
     return MALICIOUS
   // Fast specialized antibodies can short-circuit

5. TIER 2: GENERAL ANTIBODIES (parallel, ~500ms each)
   For each Active antibody where tier = General:
     result = llm_scan(antibody.prompt, content, context, allow_tools=true)

6. AGGREGATION
   votes = weighted_aggregate(all_results)
   verdict = majority_with_threshold(votes)

7. TIER 3: DEEP ANALYSIS (conditional)
   If verdict = SUSPICIOUS or (verdict = SAFE but high uncertainty):
     deep_result = multi_step_llm_analysis(content, context)
     // Multiple LLM calls with tool use
     update verdict

8. COST RECORDING
   cost_monitor.record(
     pattern_hash = content_hash,
     verdict = final_verdict,
     latency = total_latency,
     tokens = total_tokens,
     resolved_by = [antibody_ids that voted correctly]
   )

9. VACCINATION CHECK
   if cost_monitor.should_vaccinate(content_hash):
     spawn vaccination_task(content_hash)  // async, non-blocking
     result.triggered_vaccination = true

10. RETURN ScanResult
```

### 3.2 Vaccination Pipeline (Async)

```
Algorithm: vaccinate(pattern_hash) → Option<Antibody>

1. RETRIEVE PATTERN DATA
   record = cost_monitor.get(pattern_hash)
   samples = collect_samples(pattern_hash, limit=10)

2. ANTIBODY GENERATION
   // LLM creates a specialized antibody from the expensive defense experience
   // Input: samples, existing Tier 2/3 reasoning traces
   // Output: a focused, efficient defense prompt
   new_antibody = llm_generate_specialized_antibody(
     samples = samples,
     expensive_traces = get_reasoning_traces(pattern_hash),
     goal = "Create a specialized, efficient detector for this attack pattern"
   )
   new_antibody.tier = Specialized  // Target: Tier 1
   new_antibody.status = Candidate

3. SHM (SOMATIC HYPERMUTATION)
   variants = shm.mutate(
     parent = new_antibody,
     temperature = adaptive_temperature(pattern_hash),
     n_variants = config.shm_variants
   )
   // Produces N semantic variants of the antibody

4. AFFINITY MATURATION
   survivors = affinity.evaluate(
     candidates = [new_antibody] + variants,
     validation_set = build_validation_set(pattern_hash),
     config = {
       recall_weight: 0.7,      // Prioritize not missing this attack
       precision_weight: 0.3,
       fp_penalty: 0.2,
       must_detect: samples,    // Must catch the original samples
       survival_threshold: 0.6,
       max_survivors: 3,
     }
   )

5. CLONAL SELECTION
   For each survivor:
     survivor.status = Active
     survivor.generation = parent.generation + 1  // if from SHM
     antibody_pool.add(survivor)
     // Extract fast-path signatures
     memory_bank.add(extract_signatures(survivor, samples))

6. CLEANUP
   record.vaccinated = true
   record.vaccine_antibody_id = Some(best_survivor.id)
   cost_monitor.update(record)

7. Return best survivor
```

### 3.3 SHM (Adaptive Temperature)

```
Algorithm: shm.mutate(parent, temperature) → Vec<Antibody>

Temperature is ADAPTIVE:
  - Start at base_temperature (0.8)
  - If last N vaccinations produced 0 survivors → decrease by 0.1
  - If last N vaccinations produced max_survivors → increase by 0.1
  - Clamp to [0.3, 0.95]

Mutation operations (LLM chooses):
  1. PROMPT_REPHRASE — reword detection instructions
  2. HEURISTIC_ADD — add new detection pattern
  3. HEURISTIC_PRUNE — remove redundant pattern
  4. THRESHOLD_TUNE — adjust confidence threshold
  5. SCOPE_EXPAND — cover related attack variants
  6. SCOPE_NARROW — reduce false positive surface
  7. SIGNATURE_EXTRACT — add memory signatures
  8. TOOL_ADD — include a verification tool
  9. TOOL_REMOVE — remove unnecessary tool

Each variant validated:
  - Parseable (structurally valid)
  - Semantically different from parent (cosine > 0.1, < 0.95)
  - Semantically different from siblings (pairwise cosine < 0.98)
```

## 4. API Design

### 4.1 HTTP REST API

```
POST /v1/scan
  Request:  { "content": "...", "context": {...}, "mode": "full"|"fast" }
  Response: ScanResult (JSON)
  SSE:      stream antibody results as they complete

GET /v1/antibodies
  Query:    ?status=active&tier=specialized
  Response: [Antibody]

POST /v1/antibodies
  Body:     Antibody YAML → adds to pool

DELETE /v1/antibodies/:id
  Suppress or retire an antibody

GET /v1/cost/stats
  Response: cost statistics per pattern

POST /v1/vaccinate
  Body:     { "pattern_hash": "..." }
  Trigger manual vaccination

GET /v1/health
  Response: { "status": "ok", "active_antibodies": 12, "memory_entries": 1432 }
```

### 4.2 MCP Server Interface

```json
{
  "name": "caitlyn",
  "version": "0.1.0",
  "tools": [
    {
      "name": "caitlyn_scan",
      "description": "Scan content for injection/poisoning/jailbreak attacks",
      "inputSchema": {
        "type": "object",
        "properties": {
          "content": { "type": "string", "description": "External content to scan" },
          "source": { "type": "string", "description": "Content source (web, mcp, tool_output, file)" },
          "mode": { "type": "string", "enum": ["fast", "full"], "default": "full" }
        },
        "required": ["content"]
      }
    },
    {
      "name": "caitlyn_vaccinate",
      "description": "Trigger vaccination for a repeatedly expensive defense pattern",
      "inputSchema": {
        "type": "object",
        "properties": {
          "pattern_description": { "type": "string" }
        }
      }
    },
    {
      "name": "caitlyn_status",
      "description": "Get CAITLYN daemon status and stats"
    }
  ]
}
```

### 4.3 Rust Library API

```rust
use caitlyn::{Caitlyn, CaitlynConfig, ScanResult, Verdict};

let caitlyn = Caitlyn::new(CaitlynConfig::load("config.toml")?)?;

// Blocking scan
let result: ScanResult = caitlyn.scan(
    &content,
    &ScanContext {
        source: "web_search".into(),
        agent_task: Some("research security papers".into()),
        ..Default::default()
    },
)?;

// Async scan with streaming
let mut stream = caitlyn.scan_streaming(&content, &context).await?;
while let Some(partial) = stream.next().await {
    println!("Antibody {} → {:?}", partial.antibody_name, partial.verdict);
}

// Manual vaccination
caitlyn.vaccinate(&pattern_hash).await?;

// Antibody pool management
caitlyn.add_antibody(Antibody::from_yaml("path/to/skill.yaml")?)?;
caitlyn.list_antibodies(AntibodyStatus::Active, Some(DefenseTier::Specialized));
```

## 5. Configuration

```toml
# config.toml
[daemon]
http_port = 9070
mcp_mode = "stdio"          # "stdio" | "sse" | "off"
grpc_port = 9071

[llm]
provider = "deepseek"       # "deepseek" | "openai" | "anthropic"
model = "deepseek-chat"
api_key_env = "DEEPSEEK_API_KEY"
base_url = "https://api.deepseek.com"
small_model = "deepseek-chat"  # For Tier 1 specialized antibodies

[scanning]
max_parallel_tier1 = 10
max_parallel_tier2 = 5
tier1_timeout_ms = 500
tier2_timeout_ms = 3000
tier3_timeout_ms = 15000

[vaccination]
min_samples = 5                # Min encounters before vaccination
min_success_rate = 0.7         # Must be correctly detecting
latency_threshold_ms = 2000    # Trigger if avg latency > 2s
token_threshold = 4000         # Trigger if avg tokens > 4k
shm_variants = 10
shm_base_temperature = 0.8
max_survivors = 3
affinity_recall_weight = 0.7
fp_tolerance = 0.05            # Max tolerable false positive rate

[memory]
fts5_enabled = true
semantic_enabled = false       # Requires embedding model
max_entries = 100000

[storage]
db_path = "./caitlyn.db"
antibody_dir = "./antibodies"
valset_dir = "./valsets"
```

## 6. Implementation Plan

### Phase 1: Foundation (Current Session)
- [x] Design document v2
- [ ] Initialize Rust project (`cargo init`)
- [ ] Core data models: Antibody, Antigen, Memory, Verdict, CostRecord
- [ ] Configuration loading (config.toml + env vars)
- [ ] SQLite schema + migrations
- [ ] Antibody YAML loading/saving

### Phase 2: Core Scanning
- [ ] Memory Bank (exact + regex matching with FTS5)
- [ ] Antibody Pool management
- [ ] LLM provider abstraction (DeepSeek first)
- [ ] Single antibody scanning
- [ ] Multi-tier surveillance loop
- [ ] Verdict aggregation
- [ ] Cost Monitor

### Phase 3: Evolution
- [ ] Vaccination trigger logic
- [ ] Antibody generation (LLM creates specialized antibody)
- [ ] SHM Engine
- [ ] Affinity Maturation
- [ ] Clonal Selection
- [ ] Immune Tolerance (periodic pruning)

### Phase 4: Server
- [ ] HTTP REST API
- [ ] MCP Server (stdio mode)
- [ ] SSE streaming for scan progress

### Phase 5: Hardening
- [ ] Builtin antibody library (4-6 general antibodies)
- [ ] Validation set management
- [ ] Integration tests
- [ ] Benchmarks
- [ ] Documentation

## 7. Key Design Decisions (Resolved)

1. **Language**: Rust — single binary, type safety, performance for daemon
2. **Evolution trigger**: Cost-based (not label-based) — more realistic, autonomous
3. **Deployment**: Daemon with HTTP + MCP dual interface
4. **Tiered defense**: Tier 0 (memory) → Tier 1 (specialized) → Tier 2 (general) → Tier 3 (deep)
5. **Adaptive temperature**: SHM temperature self-adjusts based on vaccination success rate
6. **Benchmark strategy**: Use AgentDojo + InjecAgent as standard benchmarks; build custom evolving-attack benchmark
