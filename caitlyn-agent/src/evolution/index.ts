/**
 * CAITLYN Evolution Module
 *
 * System 2: attack-driven defense skill evolution over the DAG.
 * Generate → deterministic verify → independent review → shadow promote.
 */
export { DefenseSkillDagStore } from "./dag-store.js";
export { EvolutionEngine, dagPolicyFrom } from "./engine.js";
export { buildClusterId, extractAttackFeatures, shannonEntropy } from "./features.js";
export { EvolutionLoop } from "./loop.js";
export { LessonsStore } from "./lessons-store.js";
export { recordShadowScans } from "./runtime.js";
export { ShadowManager } from "./shadow.js";
export { appendStatsEvent, appendTriggerRecord } from "./stats-events.js";
export { StatsCollector, computeP99 } from "./stats-collector.js";
export { VerificationSandbox, isDangerousRegex } from "./verifier.js";
export { createEmptyEvidence } from "./dag-types.js";
export type { DefenseSkillNode, DefenseSkillEvidence, DagScorePolicy, NodeStatus } from "./dag-types.js";
export type { EvolutionLesson, LessonSource } from "./lessons-store.js";
export type { AttackProfile, CandidateDraft, LoopResult, ReviewSheet } from "./loop-types.js";
export type { AnomalyTrigger, StatsEvent, StatsEventSource } from "./stats-collector.js";
export type { VerifierConfig, VerificationOutcome } from "./verifier.js";
