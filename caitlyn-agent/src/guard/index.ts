/**
 * CAITLYN Guard — Barrel Export
 *
 * Defense modes for protecting LLM agents:
 *   1. FS Watcher  — monitors filesystem, scans files on write
 *   2. Agent Hooks — framework-level beforeToolCall / afterToolCall hooks
 *   3. OS Watcher  — occupancy + network energy, detect-only
 *   4. ACE Watcher — agent component-graph mutation energy
 *   5. Host steward — fused occupancy / network / component decision
 *   6. Sandbox     — process-level syscall interception (future)
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

// OS Watcher
export {
  OsWatcher,
  isOsTelemetrySource,
  mergeNetworkFeatures,
  type OsWatchIntervention,
  type OsWatchTick,
  type OsWatcherConfig,
  type OsChannelEnergies,
} from "./os-watcher.js";
export {
  AceWatcher,
  resolveComponentRoots,
  DEFAULT_ACE_WATCHER_CONFIG,
  type AceWatchTick,
  type AceWatcherConfig,
} from "./ace-watcher.js";
export {
  classifyComponentPath,
  diffComponentGraph,
  inventoryComponentGraph,
  isMutableComponentClass,
  type ComponentClass,
  type ComponentGraphDiff,
  type ComponentNode,
} from "./component-graph.js";
export {
  HostSteward,
  fuseHostChannels,
  toPublicHostSnapshot,
  toHostWatchDashboardView,
  readRecentIncidents,
  sockstatFromEvents,
  DEFAULT_HOST_STEWARD_CONFIG,
  HOST_INCIDENTS_FILENAME,
  type HostWatchSnapshot,
  type PublicHostWatchSnapshot,
  type HostWatchDashboardView,
  type HostSockstat,
  type HostIncident,
  type HostChannelName,
} from "./host-steward.js";
export {
  quarantineGraftedComponents,
  isQuarantinableGraft,
} from "./component-quarantine.js";
export {
  collectOccupancyMetrics,
  parseProcLoadavg,
  parseProcMeminfo,
  parseProcStatCpu,
  cpuBusyRatio,
  readProcFile,
  type OccupancyFeatures,
  type ProcFileReader,
} from "./os-occupancy.js";
export {
  computeOsEnergy,
  DEFAULT_OS_ENERGY_CONFIG,
  updateOsEnergyBaseline,
  type OsFeatureVector,
  type OsEnergyBaseline,
  type OsEnergyConfig,
} from "./os-energy.js";
