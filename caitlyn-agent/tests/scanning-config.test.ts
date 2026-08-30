/**
 * Tests for the [scanning] TOML configuration loading (Tier 1 escalation).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SCANNING_DEFAULTS, loadScanningConfig } from "../src/config.js";

function writeToml(dir: string, body: string): string {
  const file = path.join(dir, "config.toml");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

describe("loadScanningConfig", () => {
  it("returns defaults when the config file does not exist", () => {
    const cfg = loadScanningConfig("/nonexistent/caitlyn/config.toml");
    expect(cfg).toEqual(SCANNING_DEFAULTS);
  });

  it("loads escalation fields from a full [scanning] section", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-scan-cfg-"));
    const file = writeToml(
      dir,
      [
        "[scanning]",
        'tier1_mode = "merged"',
        'merged_scope = "detectors"',
        "skip_tier0 = true",
        "skip_tier1 = false",
        "tier0_timeout_ms = 750",
        'escalation_policy = "aggressive"',
        'fast_detector_ids = "ab-a, ab-b,ab-c"',
        "weak_signal_threshold = 0.5",
        'source_trust = "low"',
        "high_risk = true",
        "tier1_timeout_ms = 8000",
        "max_parallel_tier1 = 4",
        "",
      ].join("\n"),
    );

    const cfg = loadScanningConfig(file);
    expect(cfg.tier1Mode).toBe("merged");
    expect(cfg.mergedScope).toBe("detectors");
    expect(cfg.skipTier0).toBe(true);
    expect(cfg.skipTier1).toBe(false);
    expect(cfg.tier0TimeoutMs).toBe(750);
    expect(cfg.policy).toBe("aggressive");
    expect(cfg.fastDetectorIds).toEqual(["ab-a", "ab-b", "ab-c"]);
    expect(cfg.weakSignalThreshold).toBe(0.5);
    expect(cfg.sourceTrust).toBe("low");
    expect(cfg.highRisk).toBe(true);
    expect(cfg.tier1TimeoutMs).toBe(8000);
    expect(cfg.maxParallelTier1).toBe(4);
  });

  it("falls back to defaults for invalid enum values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-scan-cfg-"));
    const file = writeToml(
      dir,
      [
        "[scanning]",
        'tier1_mode = "batch"',
        'merged_scope = "everything"',
        'escalation_policy = "sometimes"',
        'source_trust = "root"',
        "weak_signal_threshold = -1",
        "",
      ].join("\n"),
    );

    const cfg = loadScanningConfig(file);
    expect(cfg.tier1Mode).toBe(SCANNING_DEFAULTS.tier1Mode);
    expect(cfg.mergedScope).toBe(SCANNING_DEFAULTS.mergedScope);
    expect(cfg.policy).toBe(SCANNING_DEFAULTS.policy);
    expect(cfg.sourceTrust).toBe(SCANNING_DEFAULTS.sourceTrust);
    expect(cfg.weakSignalThreshold).toBe(SCANNING_DEFAULTS.weakSignalThreshold);
  });
});
