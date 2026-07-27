/**
 * CAITLYN Evolution — Shared Types
 *
 * Mirrors the Rust core/models.rs and supporting types
 * for the vaccination pipeline.
 */

// ── Memory Bank ──────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  pattern: string;
  signatureType: "exact" | "regex";
  category: string;
  hitCount: number;
  createdAt: string;
}

export type MemoryMatch =
  | { kind: "exact"; entry: MemoryEntry }
  | { kind: "none" };

// ── Antibody (evolution-side subset) ─────────────────────────────

export interface Antibody {
  id: string;
  name: string;
  description: string;
  category: string;
  tier: number; // 0 = Specialized, 1 = General, 2 = Deep
  prompt: string;
  threshold: number;
  status: "active" | "suppressed" | "retired" | "candidate";
  stats: AntibodyStats;
}

export interface AntibodyStats {
  totalScans: number;
  truePositives: number;
  falsePositives: number;
  avgLatencyUs: number;

  /** Derived: TP / (TP + FN) */
  recall?: number;
  /** Derived: TP / (TP + FP) */
  precision?: number;
}

// ── Cost Monitor ─────────────────────────────────────────────────

export interface CostRecord {
  patternHash: string;
  sample: string;
  category: string;
  resolvedBy: string[];
  callCount: number;
  totalLatencyUs: number;
  totalTokens: number;
  successCount: number;
  failureCount: number;
  firstSeen: string;
  lastSeen: string;
  vaccinated: boolean;
  vaccineAntibodyId: string | null;
}

export interface VaccinationTriggerConfig {
  minSamples: number;
  minSuccessRate: number;
  latencyThresholdUs: number;
  tokenThreshold: number;
}

// ── Affinity Maturation ──────────────────────────────────────────

export interface AffinityConfig {
  recallWeight: number;
  precisionWeight: number;
  fpPenalty: number;
  survivalThreshold: number;
  maxSurvivors: number;
}

export interface LabeledSample {
  content: string;
  isAttack: boolean;
}

export interface AffinityResult {
  antibody: Antibody;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  affinityScore: number;
  detectedMustDetect: boolean;
}

// ── SHM Engine ───────────────────────────────────────────────────

export interface ShmVariant {
  name: string;
  description: string;
  prompt: string;
  threshold: number;
  mutationOperations: string[];
  newSignatures: string[];
}

// ── Validation Set ───────────────────────────────────────────────

export interface ValidationSet {
  mustDetect: LabeledSample[];
  shouldDetect: LabeledSample[];
  mustNotDetect: LabeledSample[];
}

// ── Vaccination Result ────────────────────────────────────────────

export interface VaccinationResult {
  antibody: Antibody;
  affinityScore: number;
  precision: number;
  recall: number;
  memoryEntries: MemoryEntry[];
}

// ── Vaccination Config ───────────────────────────────────────────

export interface VaccinationConfig {
  minSamples: number;
  minSuccessRate: number;
  latencyThresholdUs: number;
  tokenThreshold: number;
  shmVariants: number;
  shmBaseTemperature: number;
  maxSurvivors: number;
  affinityRecallWeight: number;
  fpTolerance: number;
}
