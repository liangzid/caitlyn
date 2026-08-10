/**
 * Tests for the deterministic Tier 1 escalation decision.
 */
import { describe, it, expect } from "vitest";
import {
  decideEscalation,
  hasWeakSignal,
  type EscalationInput,
} from "../src/escalation.js";

function input(overrides: Partial<EscalationInput> = {}): EscalationInput {
  return {
    t0Results: [],
    policy: "safe",
    fastDetectorIds: ["ab-a", "ab-b"],
    weakSignalThreshold: 0.6,
    sourceTrust: "medium",
    highRisk: false,
    ...overrides,
  };
}

function result(verdict: "benign" | "suspicious" | "malicious", confidence: number) {
  return {
    antibody_id: "ab-x",
    verdict,
    confidence,
    reason: null,
    latency_us: 0,
    error: null,
  };
}

describe("hasWeakSignal", () => {
  it("treats suspicious as weak", () => {
    expect(hasWeakSignal([result("suspicious", 0.5)], 0.6)).toBe(true);
  });

  it("treats sub-threshold malicious as weak", () => {
    expect(hasWeakSignal([result("malicious", 0.55)], 0.6)).toBe(true);
  });

  it("treats clean or strong-malicious results as not weak", () => {
    expect(hasWeakSignal([result("benign", 0.1)], 0.6)).toBe(false);
    expect(hasWeakSignal([result("malicious", 0.95)], 0.6)).toBe(false);
  });
});

describe("decideEscalation", () => {
  it("policy off always runs the full ensemble", () => {
    expect(decideEscalation(input({ policy: "off" })).stage).toBe("full");
  });

  it("safe policy runs the fast subset on clean scans", () => {
    expect(decideEscalation(input({ policy: "safe" })).stage).toBe("fast");
  });

  it("weak signals always escalate to full", () => {
    const weak = input({ t0Results: [result("suspicious", 0.5)] });
    expect(decideEscalation(weak).stage).toBe("full");
  });

  it("safe policy + high-risk task escalates to full", () => {
    expect(decideEscalation(input({ policy: "safe", highRisk: true })).stage).toBe("full");
  });

  it("aggressive policy skips the LLM on trusted clean scans", () => {
    const decision = decideEscalation(
      input({ policy: "aggressive", sourceTrust: "high" }),
    );
    expect(decision.stage).toBe("none");
  });

  it("aggressive policy still runs fast on untrusted or risky input", () => {
    expect(
      decideEscalation(input({ policy: "aggressive", sourceTrust: "low" })).stage,
    ).toBe("fast");
    expect(
      decideEscalation(input({ policy: "aggressive", highRisk: true })).stage,
    ).toBe("fast");
  });
});
