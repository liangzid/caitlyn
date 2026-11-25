/**
 * Tests for configurable scanner-error behavior in the filesystem watcher.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const hybridScan = vi.hoisted(() => vi.fn());

vi.mock("../../src/hybrid-scanner.js", () => ({ hybridScan }));

import { FSWatcher } from "../../src/guard/fs-watcher.js";

describe("FSWatcher scan-error policy", () => {
  let dir = "";
  let watchDir = "";
  let quarantineDir = "";

  beforeEach(() => {
    hybridScan.mockReset();
    hybridScan.mockRejectedValue(new Error("scanner unavailable"));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-fsw-error-"));
    watchDir = path.join(dir, "watch");
    quarantineDir = path.join(dir, "quarantine");
    fs.mkdirSync(watchDir, { recursive: true });
    fs.mkdirSync(quarantineDir, { recursive: true });
  });

  function scanWithErrorPolicy(onError?: "allow" | "block") {
    const filePath = path.join(watchDir, "input.txt");
    fs.writeFileSync(filePath, "ordinary content", "utf-8");
    const watcher = new FSWatcher({
      watchDirs: [watchDir],
      quarantineDir,
      ignorePatterns: [],
      skipExtensions: [],
      on_error: onError,
    });
    return { filePath, scan: watcher.scanFile(filePath) };
  }

  it("fails open by default when the scanner errors", async () => {
    const { filePath, scan } = scanWithErrorPolicy();
    const result = await scan;
    expect(result.action).toBe("allow");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("quarantines when fail-closed scanning errors", async () => {
    const { filePath, scan } = scanWithErrorPolicy("block");
    const result = await scan;
    expect(result.action).toBe("block");
    expect(result.quarantinedPath).not.toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.statSync(result.quarantinedPath!).mode & 0o777).toBe(0o600);
    expect(fs.statSync(quarantineDir).mode & 0o777).toBe(0o700);
  });

  it("treats a resolved Tier 1 fallback as a scanner error when fail-closed", async () => {
    hybridScan.mockResolvedValue({
      verdict: "benign",
      confidence: 0,
      tier: 1,
      script_results: [{
        defense_skill_id: "llm-fallback",
        verdict: "benign",
        confidence: 0,
        reason: "LLM unavailable, Tier 1 skipped",
        latency_us: 0,
        error: "provider unavailable",
      }],
      total_latency_us: 1,
      total_tokens: 0,
    });
    const { filePath, scan } = scanWithErrorPolicy("block");
    const result = await scan;
    expect(result.action).toBe("block");
    expect(result.quarantinedPath).not.toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
