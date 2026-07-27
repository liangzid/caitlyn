/**
 * CAITLYN Evolution Module
 *
 * Full vaccination pipeline: SHM → Affinity Maturation → Clonal Selection.
 * Ported from the Rust daemon (src/evolution/, src/surveillance/, src/core/).
 */
export { MemoryBank } from "./memory-bank.js";
export { CostMonitor } from "./cost-monitor.js";
export { ShmEngine } from "./shm-engine.js";
export { AffinityMaturation } from "./affinity.js";
export { VaccinationPipeline } from "./pipeline.js";
export { loadValidationSet } from "./validation-set.js";
export type {
  MemoryEntry,
  MemoryMatch,
  Antibody,
  AntibodyStats,
  CostRecord,
  VaccinationTriggerConfig,
  AffinityConfig,
  LabeledSample,
  AffinityResult,
  ShmVariant,
  ValidationSet,
  VaccinationConfig,
  VaccinationResult,
} from "./types.js";
