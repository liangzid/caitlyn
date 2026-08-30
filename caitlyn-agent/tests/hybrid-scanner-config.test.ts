/**
 * CAITLYN hybrid scanner configuration forwarding tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  loadScanningConfig: vi.fn(),
}));

vi.mock("../src/scanner.js", () => ({ scan: mocks.scan }));
vi.mock("../src/library.js", () => ({
  loadAntibodies: () => [],
  loadAntigens: () => [],
}));
vi.mock("../src/config.js", () => ({ loadScanningConfig: mocks.loadScanningConfig }));

import { hybridScan } from "../src/hybrid-scanner.js";

/** Return a minimal successful scan result for forwarding assertions. */
function successfulScanResult() {
  return {
    verdict: "benign" as const,
    confidence: 0,
    tier: 0 as const,
    script_results: [],
    total_latency_us: 1,
    total_tokens: 0,
  };
}

describe("hybridScan persisted scanning configuration", () => {
  beforeEach(() => {
    mocks.scan.mockReset();
    mocks.loadScanningConfig.mockReset();
    mocks.scan.mockResolvedValue(successfulScanResult());
    mocks.loadScanningConfig.mockReturnValue({
      tier1Mode: "merged-pair",
      mergedScope: "detectors",
      skipTier0: true,
      skipTier1: false,
      policy: "off",
      fastDetectorIds: ["ab-one"],
      weakSignalThreshold: 0.7,
      sourceTrust: "low",
      highRisk: true,
      tier1TimeoutMs: 9000,
      maxParallelTier1: 2,
    });
  });

  it("forwards every persisted detection field to the local scanner", async () => {
    const llmCall = vi.fn();
    await hybridScan({ content: "sample", llmCall });

    expect(mocks.scan).toHaveBeenCalledWith(expect.objectContaining({
      tier1Mode: "merged-pair",
      mergedScope: "detectors",
      skipTier0: true,
      skipTier1: false,
      escalationPolicy: "off",
      fastDetectorIds: ["ab-one"],
      weakSignalThreshold: 0.7,
      sourceTrust: "low",
      highRisk: true,
      tier1TimeoutMs: 9000,
      maxParallelTier1: 2,
    }));
  });

  it("lets explicit call options override persisted fields", async () => {
    await hybridScan({
      content: "sample",
      llmCall: vi.fn(),
      tier1Mode: "ensemble",
      skipTier0: false,
      sourceTrust: "high",
    });

    expect(mocks.scan).toHaveBeenCalledWith(expect.objectContaining({
      tier1Mode: "ensemble",
      skipTier0: false,
      sourceTrust: "high",
    }));
  });
});
