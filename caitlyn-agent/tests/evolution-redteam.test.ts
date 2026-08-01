/**
 * Tests for the red-team drill: real sample loading and report
 * statistics (with a stubbed Tier 0 for deterministic counting).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/scanner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scanner.js")>();
  return { ...actual, runTier0: vi.fn() };
});

import { runTier0 } from "../src/scanner.js";
import {
  loadAttackSamples,
  runRedTeam,
  type AttackSample,
} from "../src/evolution/redteam.js";

const mockedRunTier0 = vi.mocked(runTier0);

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
    mockedRunTier0.mockImplementation(async (_antibodies, content) => {
      const hit = content.includes("hit");
      return {
        results: hit
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
          : [],
        malicious: hit,
      };
    });

    const report = await runRedTeam(SAMPLES, []);
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
    mockedRunTier0.mockResolvedValue({ results: [], malicious: false });
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      content: "clean",
      category: "injection",
      attackType: "x",
    }));
    const report = await runRedTeam(many, []);
    expect(report.missedSampleIds).toHaveLength(20);
    expect(report.truncated).toBe(true);
  });
});
