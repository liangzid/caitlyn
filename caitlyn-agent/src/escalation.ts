/**
 * CAITLYN — Tier 1 Escalation Decision
 *
 * Decides how many Tier 1 LLM detectors to run for a scan:
 *   none — skip the LLM entirely (only in the "aggressive" policy)
 *   fast — run the cheap general-detector subset
 *   full — run every configured Tier 1 detector
 *
 * The decision is deterministic and cheap on purpose: this is the
 * escalation-coordinator role (ab-escalation-coordinator) implemented as
 * code instead of an extra LLM call, because an LLM gate that costs a
 * call would defeat the purpose of saving calls.
 */

import type { ScriptResult } from "./schema.js";

export type EscalationStage = "none" | "fast" | "full";
export type EscalationPolicy = "safe" | "aggressive" | "off";
export type SourceTrust = "high" | "medium" | "low";

export interface EscalationDefaults {
  policy: EscalationPolicy;
  fastDetectorIds: string[];
  weakSignalThreshold: number;
  sourceTrust: SourceTrust;
  highRisk: boolean;
}

/** Defaults chosen so recall is not sacrificed: clean scans still run
 * the fast subset, and weak signals always run the full ensemble. */
export const ESCALATION_DEFAULTS: EscalationDefaults = {
  policy: "safe",
  fastDetectorIds: [
    "ab-classifier-injection",
    "ab-classifier-jailbreak",
    "ab-builtin-poisoning",
  ],
  weakSignalThreshold: 0.6,
  sourceTrust: "medium",
  highRisk: false,
};

export interface EscalationDecision {
  stage: EscalationStage;
  reason: string;
}

export interface EscalationInput {
  t0Results: ScriptResult[];
  policy: EscalationPolicy;
  fastDetectorIds: string[];
  weakSignalThreshold: number;
  sourceTrust: SourceTrust;
  highRisk: boolean;
}

/** True when Tier 0 produced a weak but non-blocking signal. */
export function hasWeakSignal(
  results: ScriptResult[],
  weakSignalThreshold: number,
): boolean {
  return results.some(
    (r) =>
      r.verdict === "suspicious" ||
      (r.verdict === "malicious" && r.confidence < weakSignalThreshold),
  );
}

/**
 * Decide the Tier 1 stage for a scan that Tier 0 did not block.
 *
 * safe: clean scans run the fast subset; weak signals or high-risk tasks
 *       run the full ensemble. This is the recall-preserving default.
 * aggressive: clean scans on trusted content skip the LLM entirely;
 *       untrusted sources or risky tasks still get the fast subset.
 * off: always run the full ensemble (previous behavior, for comparisons).
 */
export function decideEscalation(input: EscalationInput): EscalationDecision {
  if (input.policy === "off") {
    return { stage: "full", reason: "policy=off: always run the full ensemble" };
  }

  if (hasWeakSignal(input.t0Results, input.weakSignalThreshold)) {
    return {
      stage: "full",
      reason: `tier0 weak signal below ${input.weakSignalThreshold}`,
    };
  }

  if (input.policy === "safe") {
    if (input.highRisk) {
      return { stage: "full", reason: "safe policy + high-risk task" };
    }
    return { stage: "fast", reason: "safe policy: clean scan runs fast subset" };
  }

  // aggressive policy, clean scan:
  if (input.sourceTrust === "low" || input.highRisk) {
    return { stage: "fast", reason: "aggressive policy + untrusted/risky input" };
  }
  return { stage: "none", reason: "aggressive policy: trusted clean scan skips LLM" };
}
