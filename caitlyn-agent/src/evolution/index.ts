/**
 * CAITLYN Evolution Module
 *
 * Immune System 2: antigen-driven antibody evolution over the DAG.
 * Generate → deterministic verify → independent review → shadow promote.
 */
export { AntibodyDagStore } from "./dag-store.js";
export { EvolutionEngine, dagPolicyFrom } from "./engine.js";
export { buildClusterId, extractAntigenFeatures, shannonEntropy } from "./features.js";
export { EvolutionLoop } from "./loop.js";
export { LessonsStore } from "./lessons-store.js";
export { recordShadowScans } from "./runtime.js";
export { ShadowManager } from "./shadow.js";
export { appendStatsEvent, appendTriggerRecord } from "./stats-events.js";
export { StatsCollector, computeP99 } from "./stats-collector.js";
export { VerificationSandbox, isDangerousRegex } from "./verifier.js";
export { createEmptyEvidence } from "./dag-types.js";
export type { AntibodyNode, AntibodyEvidence, DagScorePolicy, NodeStatus } from "./dag-types.js";
export type { EvolutionLesson, LessonSource } from "./lessons-store.js";
export type { AntigenProfile, CandidateDraft, LoopResult, ReviewSheet } from "./loop-types.js";
export type { AnomalyTrigger, StatsEvent, StatsEventSource } from "./stats-collector.js";
export type { VerifierConfig, VerificationOutcome } from "./verifier.js";
