/**
 * CAITLYN Guard — Barrel Export
 *
 * Three defense modes for protecting LLM agents:
 *   1. FS Watcher  — monitors filesystem, scans files on write
 *   2. Agent Hooks — framework-level beforeToolCall / afterToolCall hooks
 *   3. Sandbox     — process-level syscall interception (future)
 */

// Shared
export {
  type VerdictAction,
  type VerdictPolicy,
  type GuardEvent,
  type GuardConfig,
  verdictToAction,
  DEFAULT_VERDICT_POLICY,
  DEFAULT_GUARD_CONFIG,
} from "./types.js";

export {
  type PolicyContext,
  type PolicyDecision,
  evaluatePolicy,
  prepareContent,
} from "./policy.js";

// FS Watcher
export {
  FSWatcher,
  type FSWatcherConfig,
  type FSWatcherStats,
  type FileScanResult,
  type ExtractableType,
  DEFAULT_FS_WATCHER_CONFIG,
} from "./fs-watcher.js";

// Agent Hooks
export {
  AgentHooksEngine,
  createPiAgentHookAdapter,
  createStandaloneHooks,
  type AgentHookAdapter,
  type AgentHooksConfig,
  type AgentHooksStats,
  type HookContext,
  type HookDecision,
  type HookPoint,
  type PiAgentToolContext,
  type PiAgentMiddleware,
  DEFAULT_AGENT_HOOKS_CONFIG,
} from "./agent-hooks.js";
