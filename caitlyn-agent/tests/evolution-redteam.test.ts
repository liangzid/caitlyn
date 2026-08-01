/**
 * Tests for the red-team drill: real sample loading and report
 * statistics (with an injected Tier 0 runner for deterministic counting).
 */
import { describe, it, expect } from "vitest";
import type { LlmCallFn } from "../src/scanner.js";
import type { ScriptResult } from "../src/schema.js";
import {
  loadAttackSamples,
  runRedTeam,
  type AttackSample,
} from "../src/evolution/redteam.js";

const SAMPLES: AttackSample[] = [
  { id: "s1", content: "hit me", category: "injection", attackType: "x" },
  { id: "s2", content: "benign text", category: "injection", attackType: "x" },
  { id: "s3", content: "hit too", category: "jailbreak", attackType: "y" },
  { id: "s4", content: "clean", category: "jailbreak", attackType: "y" },
  { id: "s5", content: "clean", category: "jailbreak", attackType: "y" },
];

describe("loadAttackSamples", () => {
  it("loads real samples from the knowledge base", () => {
    const samples = loadAttackSamples();
    expect(samples.length).toBeGreaterThan(200);
    for (const s of samples.slice(0, 5)) {
      expect(s.id).toBeTruthy();
      expect(s.content.length).toBeGreaterThan(0);
      expect(s.category).toBeTruthy();
    }
  });
});

describe("runRedTeam", () => {
  it("counts detections per category and reports misses", async () => {
    const tier0Runner = async (_antibodies: unknown, content: string) => {
      const hit = content.includes("hit");
      return {
        results: (hit
          ? [
              {
                antibody_id: "ab-test",
                verdict: "malicious",
                confidence: 0.9,
                reason: "hit",
                latency_us: 10,
                error: null,
              },
            ]
          : []) as ScriptResult[],
        malicious: hit,
      };
    };

    const report = await runRedTeam(SAMPLES, [], 500, tier0Runner);
    expect(report.total).toBe(5);
    expect(report.detected).toBe(2);
    expect(report.detectionRate).toBeCloseTo(0.4, 5);

    const injection = report.byCategory.find((c) => c.category === "injection")!;
    expect(injection).toEqual({
      category: "injection",
      total: 2,
      detected: 1,
      detectionRate: 0.5,
    });
    expect(report.missedSampleIds).toEqual(["s2", "s4", "s5"]);
    expect(report.truncated).toBe(false);
  });

  it("caps the missed list at 20 and marks truncation", async () => {
    const tier0Runner = async () => ({ results: [], malicious: false });
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      content: "clean",
      category: "injection",
      attackType: "x",
    }));
    const report = await runRedTeam(many, [], 500, tier0Runner);
    expect(report.missedSampleIds).toHaveLength(20);
    expect(report.truncated).toBe(true);
  });
});
