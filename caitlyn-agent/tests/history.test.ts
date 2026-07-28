/**
 * Tests for history.ts — scan logging, dashboard stats, and history retrieval.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ScanLogEntry } from "../src/history.js";

// ── Setup temp directory BEFORE mocking ─────────────────────────
// Use vi.hoisted() so the value is available in the hoisted mock factory.

const { sessionId } = vi.hoisted(() => {
  return { sessionId: "hist-" + Date.now().toString(36) };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const tmpBase = path.join(actual.tmpdir(), `caitlyn-${sessionId}`);
  const caitlynDir = path.join(tmpBase, ".caitlyn");
  fs.mkdirSync(caitlynDir, { recursive: true });
  return {
    ...actual,
    homedir: () => tmpBase,
  };
});

// Now import the history module (it will use our mocked homedir)
import {
  logScan,
  loadHistory,
  getHistory,
  getDashboard,
  clearHistory,
  exportHistory,
} from "../src/history.js";
import type { ScanResult } from "../src/schema.js";

// Derive paths matching the mock factory
const tmpBase = path.join(os.tmpdir(), `caitlyn-${sessionId}`);
const caitlynDir = path.join(tmpBase, ".caitlyn");
const historyPath = path.join(caitlynDir, "scan_history.json");

// ── Test Helpers ────────────────────────────────────────────────────

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    verdict: "benign",
    confidence: 0.95,
    tier: 1,
    script_results: [],
    total_latency_us: 1000,
    total_tokens: 500,
    ...overrides,
  };
}
function resetHistoryFile(): void {
  // Write empty content (not "[]" which is JSON array format)
  // logScan appends JSONL lines, so start with an empty file
  fs.writeFileSync(historyPath, "", "utf-8");
}

// ── Cleanup ─────────────────────────────────────────────────────────

afterEach(() => {
  resetHistoryFile();
});

afterAll(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// ── Tests ───────────────────────────────────────────────────────────

describe("loadHistory", () => {
  it("returns empty array when history file is empty", () => {
    resetHistoryFile();
    const entries = loadHistory();
    expect(entries).toEqual([]);
  });

  it("returns entries from JSON array format", () => {
    const entries: ScanLogEntry[] = [
      {
        timestamp: "2025-06-01T00:00:00Z",
        content_hash: "abc123",
        content_preview: "test content",
        verdict: "benign",
        confidence: 0.9,
        tier: 1,
        total_latency_us: 500,
        total_tokens: 200,
        antibody_hits: [],
        source: "test",
      },
    ];
    fs.writeFileSync(historyPath, JSON.stringify(entries), "utf-8");

    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].content_hash).toBe("abc123");
    expect(loaded[0].verdict).toBe("benign");
  });

  it("handles non-array JSON by falling through to JSONL parsing", () => {
    // When the file starts with '{' (not '['), it's parsed as JSONL.
    // A single JSON object on one line parses as a valid JSONL entry.
    fs.writeFileSync(historyPath, JSON.stringify({ not: "array" }), "utf-8");
    const loaded = loadHistory();
    // Falls through to JSONL parsing — the object IS a valid JSON line
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ not: "array" });
  });

  it("handles JSONL format (one object per line)", () => {
    const entry1: ScanLogEntry = {
      timestamp: "2025-06-01T00:00:00Z",
      content_hash: "hash1",
      content_preview: "first",
      verdict: "malicious",
      confidence: 0.8,
      tier: 0,
      total_latency_us: 100,
      total_tokens: 50,
      antibody_hits: ["ab-1"],
      source: "test",
    };
    const entry2: ScanLogEntry = {
      timestamp: "2025-06-02T00:00:00Z",
      content_hash: "hash2",
      content_preview: "second",
      verdict: "benign",
      confidence: 0.95,
      tier: 1,
      total_latency_us: 200,
      total_tokens: 80,
      antibody_hits: [],
      source: "test",
    };

    fs.writeFileSync(
      historyPath,
      JSON.stringify(entry1) + "\n" + JSON.stringify(entry2) + "\n",
      "utf-8",
    );

    const loaded = loadHistory();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].content_hash).toBe("hash1");
    expect(loaded[1].content_hash).toBe("hash2");
  });

  it("returns empty array when file does not exist", () => {
    try { fs.unlinkSync(historyPath); } catch {}
    const entries = loadHistory();
    expect(entries).toEqual([]);
  });
});

describe("logScan", () => {
  it("appends an entry to the history", async () => {
    resetHistoryFile();

    const result = makeScanResult({
      verdict: "malicious",
      confidence: 0.85,
      tier: 0,
      script_results: [
        {
          antibody_id: "ab-test",
          verdict: "malicious",
          confidence: 0.85,
          reason: "Found injection",
          latency_us: 500,
          error: null,
        },
      ],
      total_latency_us: 1500,
      total_tokens: 300,
    });

    await logScan(result, "DROP TABLE users; --", "caitlyn-agent");

    const entries = loadHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0].verdict).toBe("malicious");
    expect(entries[0].tier).toBe(0);
    expect(entries[0].antibody_hits).toContain("ab-test");
    expect(entries[0].source).toBe("caitlyn-agent");
    expect(entries[0].content_preview.length).toBeLessThanOrEqual(120);
    expect(entries[0].timestamp).toBeTruthy();
  });

  it("truncates content preview to 120 characters", async () => {
    resetHistoryFile();
    const longContent = "x".repeat(500);
    await logScan(makeScanResult(), longContent);
    const entries = loadHistory();
    expect(entries[0].content_preview.length).toBe(120);
  });

  it("only includes malicious script results in antibody_hits", async () => {
    resetHistoryFile();

    const result = makeScanResult({
      script_results: [
        {
          antibody_id: "ab-benign",
          verdict: "benign",
          confidence: 0.9,
          reason: "Looks safe",
          latency_us: 100,
          error: null,
        },
        {
          antibody_id: "ab-malicious",
          verdict: "malicious",
          confidence: 0.95,
          reason: "Found attack",
          latency_us: 200,
          error: null,
        },
        {
          antibody_id: "ab-suspicious",
          verdict: "suspicious",
          confidence: 0.6,
          reason: "Unusual",
          latency_us: 150,
          error: null,
        },
      ],
    });

    await logScan(result, "test content");

    const entries = loadHistory();
    expect(entries[0].antibody_hits).toEqual(["ab-malicious"]);
  });

  it("uses default source when not specified", async () => {
    resetHistoryFile();
    await logScan(makeScanResult(), "test");
    const entries = loadHistory();
    expect(entries[0].source).toBe("caitlyn-agent");
  });

  it("generates consistent content hash", async () => {
    resetHistoryFile();
    await logScan(makeScanResult(), "consistent content");
    const entries = loadHistory();
    const hash = entries[0].content_hash;
    expect(hash).toBeTruthy();
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});

describe("getHistory", () => {
  beforeEach(() => {
    resetHistoryFile();
  });

  it("returns last N entries (default 20)", async () => {
    for (let i = 0; i < 25; i++) {
      await logScan(
        makeScanResult({ total_latency_us: i * 100 }),
        `content ${i}`,
      );
    }

    const history = getHistory();
    expect(history).toHaveLength(20);
    expect(history[0].content_preview).toContain("content 24");
  });

  it("returns last N entries with custom limit", async () => {
    for (let i = 0; i < 10; i++) {
      await logScan(makeScanResult(), `content ${i}`);
    }

    const history = getHistory(5);
    expect(history).toHaveLength(5);
    expect(history[0].content_preview).toContain("content 9");
  });

  it("returns empty array when no history exists", () => {
    const history = getHistory();
    expect(history).toEqual([]);
  });

  it("returns all entries when limit exceeds total", async () => {
    for (let i = 0; i < 3; i++) {
      await logScan(makeScanResult(), `content ${i}`);
    }

    const history = getHistory(100);
    expect(history).toHaveLength(3);
  });
});

describe("getDashboard", () => {
  beforeEach(() => {
    resetHistoryFile();
  });

  it("computes correct stats with 0 scans", () => {
    const stats = getDashboard();
    expect(stats).toEqual({
      total_scans: 0,
      malicious_count: 0,
      benign_count: 0,
      detection_rate: 0,
      avg_latency_ms: 0,
      avg_tokens: 0,
      total_tokens: 0,
      tier0_hits: 0,
      tier1_hits: 0,
      last_scan_at: null,
      top_antibodies: [],
    });
  });

  it("computes correct stats with mixed scans", async () => {
    await logScan(
      makeScanResult({
        verdict: "malicious",
        confidence: 0.9,
        tier: 0,
        total_latency_us: 1000,
        total_tokens: 100,
        script_results: [
          { antibody_id: "ab-a", verdict: "malicious", confidence: 0.9, reason: "hit", latency_us: 500, error: null },
        ],
      }),
      "attack content 1",
    );

    await logScan(
      makeScanResult({
        verdict: "benign",
        confidence: 0.95,
        tier: 1,
        total_latency_us: 2000,
        total_tokens: 200,
        script_results: [],
      }),
      "safe content 1",
    );

    await logScan(
      makeScanResult({
        verdict: "malicious",
        confidence: 0.8,
        tier: 0,
        total_latency_us: 3000,
        total_tokens: 150,
        script_results: [
          { antibody_id: "ab-a", verdict: "malicious", confidence: 0.8, reason: "hit again", latency_us: 700, error: null },
          { antibody_id: "ab-b", verdict: "malicious", confidence: 0.85, reason: "also hit", latency_us: 600, error: null },
        ],
      }),
      "attack content 2",
    );

    await logScan(
      makeScanResult({
        verdict: "benign",
        confidence: 0.99,
        tier: 1,
        total_latency_us: 500,
        total_tokens: 75,
        script_results: [],
      }),
      "safe content 2",
    );

    const stats = getDashboard();

    expect(stats.total_scans).toBe(4);
    expect(stats.malicious_count).toBe(2);
    expect(stats.benign_count).toBe(2);
    expect(stats.detection_rate).toBe(0.5);
    expect(stats.total_tokens).toBe(525);
    expect(stats.avg_tokens).toBe(131.25);
    expect(stats.avg_latency_ms).toBeCloseTo(1.625, 3);
    expect(stats.tier0_hits).toBe(2);
    expect(stats.tier1_hits).toBe(0);
    expect(stats.top_antibodies).toHaveLength(2);
    expect(stats.top_antibodies[0].id).toBe("ab-a");
    expect(stats.top_antibodies[0].hits).toBe(2);
    expect(stats.top_antibodies[1].id).toBe("ab-b");
    expect(stats.top_antibodies[1].hits).toBe(1);
    expect(stats.last_scan_at).toBeTruthy();
  });

  it("computes detection_rate as 0 when no scans", () => {
    const stats = getDashboard();
    expect(stats.detection_rate).toBe(0);
  });

  it("computes detection_rate as 1.0 when all are malicious", async () => {
    for (let i = 0; i < 3; i++) {
      await logScan(
        makeScanResult({ verdict: "malicious" }),
        `malicious ${i}`,
      );
    }
    const stats = getDashboard();
    expect(stats.detection_rate).toBe(1.0);
  });
});

describe("clearHistory", () => {
  it("removes all entries", async () => {
    resetHistoryFile();
    await logScan(makeScanResult(), "test content");
    expect(loadHistory()).toHaveLength(1);
    await clearHistory();
    expect(loadHistory()).toEqual([]);
  });
});

describe("exportHistory", () => {
  let exportPath: string;

  beforeEach(() => {
    exportPath = path.join(tmpBase, "exported_history.json");
  });

  afterEach(() => {
    try { fs.unlinkSync(exportPath); } catch {}
  });

  it("exports entries to a JSON file and returns count", async () => {
    resetHistoryFile();
    await logScan(makeScanResult(), "content 1");
    await logScan(makeScanResult(), "content 2");

    const count = exportHistory(exportPath);
    expect(count).toBe(2);
    expect(fs.existsSync(exportPath)).toBe(true);
    const exported = JSON.parse(fs.readFileSync(exportPath, "utf-8"));
    expect(exported).toHaveLength(2);
  });

  it("returns 0 when no entries exist", () => {
    resetHistoryFile();
    const count = exportHistory(exportPath);
    expect(count).toBe(0);
    expect(fs.existsSync(exportPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(exportPath, "utf-8"))).toEqual([]);
  });
});
