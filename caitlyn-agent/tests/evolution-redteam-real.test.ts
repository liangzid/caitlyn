/**
 * Real integration test for the red-team drill: actual knowledge-base
 * samples through the actual Tier 0 detector stack.
 */
import { describe, it, expect } from "vitest";
import { loadAntibodies } from "../src/library.js";
import { loadAttackSamples, runRedTeam } from "../src/evolution/redteam.js";

describe("red-team drill (real stack)", () => {
  it("runs a small real sample set through real Tier 0 detectors", async () => {
    const samples = loadAttackSamples().slice(0, 5);
    const report = await runRedTeam(samples, loadAntibodies());

    expect(report.total).toBe(5);
    expect(report.detected).toBeGreaterThanOrEqual(0);
    expect(report.detected).toBeLessThanOrEqual(5);
    expect(report.detectionRate).toBeGreaterThanOrEqual(0);
    expect(report.detectionRate).toBeLessThanOrEqual(1);
    expect(report.byCategory.length).toBeGreaterThan(0);
  });
});
