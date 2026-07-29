# CAITLYN Comprehensive Code Review & TODO

2025-07-25 — Full-system audit across TypeScript agent, Rust daemon, antibody/antigen library, YAML parser, TUI, eval framework.

**Update 2026-07-28**: Rust → TypeScript 架构迁移后，所有 Rust issues (H7-H13) 自动解决。
C1-C3, M1-M3, M10, H4 已修复。剩余 ~20 issues 待处理。

## 🔴 CRITICAL: User-Facing Bugs (User Reported)
### C1. Agent Cannot Exit (TUI mode) ✅ FIXED

**Files**: `caitlyn-agent/src/caitlyn-tui.ts`, `caitlyn-agent/src/cli.ts`

**Fix applied**: Ctrl+C 先关闭 overlay，无 overlay 时调用 process.exit()。Esc 键退出 overlay。commit: 9bad5bf, dc2ac33.

### C2. list_antibodies Shows Empty (index.json Poisoning) ✅ FIXED

**Files**: `caitlyn-agent/src/library.ts`, `caitlyn-agent/src/tools.ts`

**Fix applied**: 启动时检查 index.roots.length === 0 → 自动 rebuild + persist。commit: 91c13e9.

### C3. Antibody Index Never Persisted ✅ FIXED

**Files**: `caitlyn-agent/src/library.ts`

**Fix applied**: saveAntibodyIndex() 现在在 build 时和 save 后自动调用。commit: 91c13e9.

### C4. Scanner: `spawn()` Error Crashes Process

**File**: `caitlyn-agent/src/scanner.ts:27-58`

`spawn("npx", ["tsx", ...])` has no `"error"` event handler at module level — only inside `runScript()`. Since v0.80.6+ of pi-agent-core, if `npx` or `tsx` is missing at process start, the error may propagate as unhandled. The `runScript` function DOES handle `child.on("error")` (line 49), but if the error fires between `spawn()` and the handler attachment, it's uncaught.

**Status from prior audit**: Was reported as fixed but needs verification — the `"error"` handler IS present on line 49 but attaches after `spawn()` returns. In Node.js, the `error` event on `child_process` is typically deferred to the next tick, so this should be OK. Worth smoke-testing.

**Fix**: Add a `{shell: false}` option (already default), and ensure `npx`/`tsx` are checked in `checkDependencies()` before scanning.

### C5. Scanner: Tier 0 stdin Write Errors Silently Ignored

**File**: `caitlyn-agent/src/scanner.ts:117-118`

```ts
child.stdin?.write(opts.content);
child.stdin?.end();
```

If the child process dies before `write()` completes, the error is silently swallowed (the `"error"` event fires but `settled` may already be true from another path). Large content can exceed the pipe buffer, causing partial writes.

**Fix**: Listen for `"error"` on `child.stdin`, and check `child.stdin.write()` return value — if `false`, wait for `"drain"` before calling `end()`.

### C6. History: Read-Modify-Write Race Loses Scan Entries

**File**: `caitlyn-agent/src/history.ts:86-108`

`logScan()` calls `loadHistory()` → push entry → `saveHistory()`. Without file locking, two concurrent scans produce a classic lost-update pattern.

**Status from prior audit**: A `withLock()` helper was added (line 72-84) using a Promise chain. However, it only serializes writes within the same process. Two processes (or two TUI instances) still race.

**Fix**: Use `fs.writeFileSync` with `{flag: "a"}` for append-only, or use `flock` / file-based lock. Alternatively, use a SQLite database (the daemon already has one).

### C7. Session File Corruption from Non-Atomic Full Rewrite

**File**: `caitlyn-agent/src/session/session-manager.ts:458`

`flush()` does a full file rewrite. If the process crashes mid-write, the entire session is corrupted.

**Status from prior audit**: Reported as "append-only" in comments but implementation is full rewrite. Still unfixed.

**Fix**: Truly append-only: `fs.appendFileSync(this.filePath, lines.join(""), "utf-8")`. The `load()` path already handles JSONL line-by-line.

---

## 🟠 MAJOR: Correctness & Robustness

### M1. YAML Parser: Multi-Line Strings Not Supported ✅ FIXED

**Fix applied**: commit b0e0854 — 支持 multi-line strings, list-of-objects, arbitrary nesting.

### M2. YAML Parser: List-of-Objects Parsed as Scalars ✅ FIXED

**Fix applied**: commit b0e0854.

### M3. YAML Parser: Only 1 Nesting Level ✅ FIXED

**Fix applied**: commit b0e0854 — 支持任意深度嵌套。
### M4. Antibody Cache TTL = 5 Seconds

**File**: `caitlyn-agent/src/library.ts:175`

The 5-second cache means:
- If a vaccination creates a new antibody, it will not be visible for up to 5 seconds
- Every 5 seconds, the entire directory is re-scanned (O(n) `readdirSync` + `statSync` + `readFileSync`)
- Cache is invalidated on `saveAntibody()` but NOT on external changes

**Fix**: Increase TTL to 30-60s for production, or use `fs.watch` for directory monitoring.

### M5. saveAntibody() Uses Wrong Antibodies Directory

**File**: `caitlyn-agent/src/tools.ts:415`

```ts
const AB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "antibodies");
```

When running from `dist/` (compiled), this resolves to `caitlyn-agent/antibodies/` — correct. But when running via `tsx` (dev mode), `import.meta.url` points to `src/tools.ts`, so this resolves to `caitlyn-agent/antibodies/` — also coincidentally correct. However, this is fragile: the `library.ts` already exports `ANTIBODIES_DIR` based on `PROJECT_ROOT`. The vaccination path should use the same constant.

**Also**: After saving, `saveAntibody()` invalidates `_cachedAntibodies` but does NOT rebuild/persist the antibody index. The new antibody is invisible in `list_antibodies` until the index is manually rebuilt.

### M6. TUI stop() Called Twice Destroys State

**File**: `caitlyn-agent/src/caitlyn-tui.ts:1333-1351`

`stop()` is not idempotent — if called twice (e.g., Ctrl+C fires while `/quit` handler is running), `this.tui.stop()` may throw or leave terminal in raw mode.

### M7. Agent Listener Has No Unsubscribe Path

**File**: `caitlyn-agent/src/caitlyn-tui.ts:493`

`agent.subscribe(callback)` has no return value for unsubscription. Multiple TUI instances (theoretically) would receive duplicate events.

### M8. Session: `buildSessionContext()` Off-By-One

**File**: `caitlyn-agent/src/session/session-manager.ts:376`

When no compaction exists, `compactFromIndex` defaults to `-1`. The loop starts at `Math.max(compactFromIndex + 1, 0)` = 0, which is correct. BUT when compaction DOES exist at index N, the loop starts at N+1, and messages before the compaction point are NOT included — only the compacted summary + post-compaction messages are sent. This may or may not be intentional; the design intent is unclear.

### M9. `loadHistory()` Swallows All Errors → Silent Data Loss

**File**: `caitlyn-agent/src/history.ts:86-101`

Any I/O or parse error → returns `[]`. A corrupted `scan_history.json` file silently presents as "no history."

**Fix**: Log the error, back up the corrupted file, return empty array.
### M10. Scanner: `"suspicious"` Verdict Defined but Never Produced ✅ FIXED

**Fix applied**: commit 0995d4d — Tier 0 scripts 现在可输出 suspicious verdict。

---

## 🟡 MODERATE: Half-Implemented & Performance

### H1. caitlyn_vaccinate Tool: Requires Antibodies Dir Write Access

**File**: `caitlyn-agent/src/tools.ts:370-452`

The tool generates an antibody variant via LLM and saves it. But:
- No validation that the generated detect logic is syntactically valid
- No `detect.ts` script is generated — the antibody is Tier 1 only (`scriptPath: null`)
- The persisted antibody has `affinity_score: 0` with no evaluation
- Index is not rebuilt after save

### H2. caitlyn_vaccinate Tool: No Evaluation Step

**File**: `caitlyn-agent/src/tools.ts:370-452`

The `caitlyn_vaccinate` tool generates a candidate but never evaluates it against antigens (TP/FP/FN). The `evaluate_antibody` tool exists but is separate. The vaccination flow should chain: generate → evaluate → report → save.

### H3. Performance: Every Tool Call Reloads from Disk

**File**: `caitlyn-agent/src/tools.ts:118-119`

`caitlyn_scan` calls `loadAntibodies()` + `loadAntigens()` on every invocation. With 20+ antibodies, this means `readdirSync` + `statSync` × 20 + `readFileSync(config.yaml)` × 20 + `readFileSync(README.md)` × 20. With a 5-second cache, this happens at most once per 5 seconds, but it's still O(n) I/O per window.

**Fix**: Use a file watcher or longer cache TTL. Pre-build the index at startup.
### H4. Performance: `npx tsx` Overhead ~500ms per Script ✅ FIXED

**Fix applied**: commit 2d5a9de, 3d9dafb — detect.ts 预编译为 .mjs, scripts/precompile-antibodies.ts.


### H5. Scan Content Passed via stdin → OS Pipe Buffer Limit

**File**: `caitlyn-agent/src/scanner.ts:117`

Content is written to child process stdin. The pipe buffer is OS-limited (~64KB on Linux). Large content (>64KB) may block the write.

**Fix**: Use `child.stdin.write(content, callback)` and wait for drain before `end()`. Or use an environment variable (which has its own ~128KB limit on some systems).

### H6. History: Full File Rewrite on Every logScan()

**File**: `caitlyn-agent/src/history.ts:103-108`

`saveHistory()` rewrites the entire file on every scan log. With 1000+ entries, this is O(n) I/O per scan.

**Fix**: Append-only JSONL format (one JSON object per line, same as sessions).
### ~~H7. Rust: `vaccinate()` in lib.rs Not Actually Persisting~~ ✅ RESOLVED (Rust deleted)

~~**File**: `src/lib.rs:137-168`~~ — src/ 已删除。TS evolution/pipeline.ts 正确持久化。

### ~~H8. Rust: Scanner `tokens_used` Always 0~~ ✅ RESOLVED (Rust deleted)

~~**File**: `src/surveillance/scanner.rs`~~ — src/ 已删除。TS 实现直接使用 LLM API 返回的 usage。

### ~~H9. Rust: `max_parallel_tier1` / `max_parallel_tier2` Config Unused~~ ✅ RESOLVED (Rust deleted)

~~**File**: `src/surveillance/scanner.rs:178-239`~~ — src/ 已删除。

### ~~H10. Rust: Fail-Open on LLM Parse Errors~~ ✅ RESOLVED (Rust deleted)

~~**File**: `src/surveillance/scanner.rs:84`~~ — src/ 已删除。TS scanner 在解析失败时返回 suspicious。

### ~~H11. Rust: Hardcoded DeepSeek Provider in main.rs~~ ✅ RESOLVED (Rust deleted)

~~**File**: `src/main.rs:59-79`~~ — src/ 已删除。TS 使用 pi-ai 统一 LLM 接口。

### ~~H12. Rust: No Graceful Shutdown~~ ✅ RESOLVED (Rust deleted)

~~**File**: `src/main.rs:89-111`~~ — src/ 已删除。

### ~~H13. Rust: Synchronous File I/O in Async Functions~~ ✅ RESOLVED (Rust deleted)

~~**File**: `src/storage/antibody_store.rs:9-25`~~ — src/ 已删除。TS 中所有文件 I/O 为异步。

---

## 🟢 MINOR: Polish & Code Quality

### P1. `coerceValue()` Treats Empty String Same as Explicit `null`

**File**: `caitlyn-agent/src/yaml-parser.ts:13-24`

`coerceValue("")` returns `""`, but `coerceValue(null)` returns `null`. In the top-level parser, `rawValue === ""` opens a nested block, so this is OK. But if an explicit empty string `key: ""` is parsed, the value after quote-stripping is `""`, which is treated as a string — correct. The concern is only for `key: ` (no value), which is correctly handled.

### P2. `aggregateStats()` Uses `Math.max`-like Pattern for Averaging

**File**: `caitlyn-agent/src/library.ts:338-357`

The function computes weighted latency average using `weightedLatencySum / merged.total_scans`, which is correct. No issue here on further review.

### P3. `SessionManager.open()` Breaks on CRLF Line Endings

**File**: `caitlyn-agent/src/session/session-manager.ts`

`raw.split("\n")` leaves trailing `\r` on Windows-created session files. JSON.parse handles it, but the trailing `\r` becomes part of the parsed text.

### P4. `SessionManager.list()` Re-reads ALL Session Files on Every Call

**File**: `caitlyn-agent/src/session/session-manager.ts`

O(n) I/O to list sessions. OK for <100 sessions but will degrade.

### P5. TUI Footer Width Ignores CJK Characters

**File**: `caitlyn-agent/src/caitlyn-tui.ts`

CJK characters are 2 columns wide but counted as 1 in the footer width calculation.

### P6. TUI `buildDashboardOverlay()` Shows NaN/Infinity on Empty Stats

**File**: `caitlyn-agent/src/caitlyn-tui.ts:179-206`

When `total_scans === 0`, division by zero produces `NaN` in detection rate display.

### P7. TUI `buildSessionPickerOverlay()` Blank Lines for Unnamed Sessions

**File**: `caitlyn-agent/src/caitlyn-tui.ts:259-277`

Entries with no `name` render as blank lines in the picker.

### P8. TUI: No Scroll Indicators on Overlays

Users cannot tell if overlay content continues beyond the visible area.

### P9. `formatTree()` Has No Cycle Detection

**File**: `caitlyn-agent/src/tools.ts:61-104`

Circular `parent_id` references cause infinite recursion.

**Fix**: Use a `visited: Set<string>` parameter (already declared but not fully implemented — the `visited` set is created but never checked/populated with children).

### P10. REPL: No Signal Handling

**File**: `caitlyn-agent/src/repl.ts:53-77`

Ctrl+C kills the REPL process instead of interrupting the current operation. No `SIGINT` handler is registered.

### P11. CLI `setup` Wizard: No Timeout on LLM Ping

**File**: `caitlyn-agent/src/cli.ts:285-303`

The `complete(model, ctx)` call has no timeout. If the API is unreachable, the setup wizard hangs indefinitely.

### P12. `config.ts` Only Reads Env Vars; `config.toml` Not Loaded by Agent

**File**: `caitlyn-agent/src/config.ts:12-17`

The agent's `loadConfig()` only reads `CAITLYN_PROVIDER` and `CAITLYN_MODEL` env vars. The `config.toml` scanning/vaccination/memory settings are only read by the Rust daemon.

### P13. Rust: `config.rs` `gRPC_port` Field Defined but Unused

**File**: `src/config.rs`

Dead code. Should be removed or implemented.

### P14. Rust: SQLite Schema Has No Migration Versioning

**File**: `src/storage/db.rs`

Schema changes require manual intervention. No `schema_version` table.

### P15. Rust: `memory_fts` FTS5 Table Has No Sync Triggers

**File**: `src/storage/db.rs`

FTS5 content gets stale when `memory_entries` is updated. Need triggers or periodic rebuild.

### P16. Rust: `#[allow(dead_code)]` on `JsonRpcRequest.jsonrpc`

**File**: `src/server/mcp.rs:52`

The `jsonrpc` field should be validated (must be `"2.0"`), not suppressed.

### P17. Rust: Inconsistent Error Typing

**File**: `src/main.rs`

`main()` returns `anyhow::Result` while the library uses `CaitlynResult`. The `anyhow::Error` → `CaitlynError` conversion exists but loses context.

### P18. Agent Cannot Check Antigen Count Easily

**File**: `caitlyn-agent/src/tools.ts:157-178`

`list_antigens` works but there's no `dashboard` integration for antigen stats. The TUI footer shows antibody count but not antigen count.

---

## 🔵 EVALUATION FRAMEWORK ISSUES

### E1. AgentEval Has No TypeScript Agent Integration

**File**: `AgentEval/`

The eval framework (`run_benchmark.py`, `run_experiment.py`) tests defenses against simulated agents via Docker, but has no integration with the actual `caitlyn-agent` TypeScript code. The eval framework's `caitlyn_client.py` talks to the Rust daemon only.

### E2. AgentEval Uses Fake MCP, Not Real MCP

**File**: `AgentEval/src/agent_eval/security/fake_mcp.py`

The MCP testing uses a simplified mock, not the real `src/server/mcp.rs` implementation. Test results may not reflect real MCP behavior.

### E3. Integration Tests Directory Is Empty

**File**: `tests/integration/`

The directory exists but contains no tests. Cross-subsystem testing (agent + daemon, scanner + antibodies, vaccination end-to-end) is not covered.

---

## 📊 Summary Statistics

| Severity | Count | Categories |
|----------|-------|-----------|
| 🔴 Critical | 7 | C1-C7: exit, index, data loss |
| 🟠 Major | 10 | M1-M10: YAML, cache, correctness |
| 🟡 Moderate | 13 | H1-H13: half-implemented, perf |
| 🟢 Minor | 18 | P1-P18: polish, code quality |
| 🔵 Eval | 3 | E1-E3: testing gaps |
| **Total** | **51** | |

---

## 🎯 Top 10 Fixes by User Impact

| # | Issue | Symptom | Fix Complexity |
|---|-------|---------|---------------|
| 1 | **C2: index.json empty → antibodies invisible** | `list_antibodies` shows nothing | Trivial (1 line) |
| 2 | **C1: Agent cannot exit** | Process hangs after `/quit` | Small (3 lines) |
| 3 | **C3: Index never persisted** | Antibodies disappear after restart | Small |
| 4 | **M1: YAML multi-line truncated** | Antibody prompt field silently broken | Medium (rewrite parser) |
| 5 | **M5: saveAntibody wrong path + no index update** | Vaccinated antibodies invisible | Small |
| 6 | **C6: History race condition** | Scan entries silently lost | Medium |
| 7 | **C7: Session file corruption** | Chat history lost on crash | Small (append-only) |
| 8 | **H7: Rust vaccinate() doesn't persist** | Core value proposition broken | Medium |
| 9 | **H10: Rust fail-open on parse errors** | Security: attacks bypass on LLM error | Small |
| 10 | **H11: Rust hardcoded DeepSeek** | Non-DeepSeek config is ignored | Small |

---

## 🔧 Recommended Implementation Order

1. **Fix C2 + C3** (index) — unblocks `list_antibodies` and status commands
2. **Fix C1** (exit) — makes the agent usable
3. **Fix M5 + C3** (vaccination save path + index rebuild) — enables vaccination
4. **Fix C7** (append-only sessions) — prevent data loss
5. **Fix H7** (Rust vaccinate persist) — core feature works
6. **Fix M1/M2/M3** (YAML parser) — unblocks proper config parsing
7. **Fix C6** (history race) — prevent scan log loss
8. **Fix H10** (fail-open → fail-closed) — security hardening
9. **Fix H8/H9/H11** (Rust scanner bugs) — daemon correctness
10. **Remaining Major + Moderate** — robustness and performance
