/**
 * Tests for the resident Tier 0 worker pool: reuse, timeout recovery,
 * crash recovery, and one-shot fallback for non-module scripts.
 */
import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTier0, shutdownTier0Pool } from "../src/scanner.js";
import type { AntibodyEntry } from "../src/schema.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-pool-"));

function writeFixture(name: string, body: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

const goodPath = writeFixture(
  "good.mjs",
  'export function detect(content) { return { verdict: "malicious", confidence: 0.9, reason: "fixture" }; }',
);
const hungPath = writeFixture(
  "hung.mjs",
  "export function detect(content) { while (true) {} }",
);
const crashPath = writeFixture(
  "crash.mjs",
  "export function detect(content) { process.exit(1); }",
);
const plainPath = writeFixture(
  "plain.mjs",
  'console.log(JSON.stringify({ verdict: "suspicious", confidence: 0.5, reason: "plain" }));',
);

function makeEntry(id: string, scriptPath: string): AntibodyEntry {
  return {
    config: {
      id,
      name: id,
      parent_id: null,
      category: "injection",
      tier: 0,
      threshold: 0.6,
      description: "fixture",
      prompt: "",
      role: "detector",
      implementation_status: "active",
      execution_stages: ["content_scan"],
      references: [],
      runtime_requirements: [],
      affinity_score: 0,
      created_at: "2026-08-11",
      generation: 0,
      deps: [],
      signatures: [],
      stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
    },
    readme: "",
    scriptPath,
    folderPath: tmp,
  };
}

afterAll(() => {
  shutdownTier0Pool();
});

describe("Tier0 resident worker pool", () => {
  it("returns detector verdicts through the resident worker", async () => {
    const { results, malicious } = await runTier0(
      [makeEntry("ab-good", goodPath)],
      "anything",
      500,
    );
    expect(malicious).toBe(true);
    expect(results[0]?.verdict).toBe("malicious");
    expect(results[0]?.confidence).toBe(0.9);
  });

  it("reuses the same worker across scans", async () => {
    const ab = makeEntry("ab-good", goodPath);
    await runTier0([ab], "first", 500);
    const second = await runTier0([ab], "second", 500);
    expect(second.malicious).toBe(true);
  });

  it("kills and restarts the worker after a hung detector times out", async () => {
    const hung = await runTier0([makeEntry("ab-hung", hungPath)], "x", 100);
    expect(hung.results[0]?.error).toContain("timeout");

    const after = await runTier0([makeEntry("ab-good", goodPath)], "x", 500);
    expect(after.malicious).toBe(true);
  });

  it("restarts the worker after a detector crashes the process", async () => {
    const crashed = await runTier0([makeEntry("ab-crash", crashPath)], "x", 500);
    expect(crashed.results[0]?.error).toContain("worker exited");

    const after = await runTier0([makeEntry("ab-good", goodPath)], "x", 500);
    expect(after.malicious).toBe(true);
  });

  it("falls back to one-shot spawn for plain scripts the worker cannot load", async () => {
    const { results } = await runTier0([makeEntry("ab-plain", plainPath)], "x", 500);
    expect(results[0]?.verdict).toBe("suspicious");
    expect(results[0]?.confidence).toBe(0.5);
  });
});
