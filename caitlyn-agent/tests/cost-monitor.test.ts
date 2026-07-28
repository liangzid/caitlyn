/**
 * Tests for CostMonitor — cost tracking and vaccination thresholds.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CostMonitor } from "../src/evolution/index.js";
import type { CostRecord, VaccinationTriggerConfig } from "../src/evolution/types.js";

// ── Test Helpers ────────────────────────────────────────────────────

const defaultConfig: VaccinationTriggerConfig = {
  minSamples: 5,
  minSuccessRate: 0.7,
  latencyThresholdUs: 2_000_000,
  tokenThreshold: 4000,
};

// ── Tests ───────────────────────────────────────────────────────────

describe("CostMonitor", () => {
  let monitor: CostMonitor;

  beforeEach(() => {
    monitor = new CostMonitor(defaultConfig);
  });

  describe("computePatternHash()", () => {
    it("is deterministic — same input produces same hash", () => {
      const input = "SELECT * FROM users WHERE id = 1";
      const hash1 = monitor.computePatternHash(input);
      const hash2 = monitor.computePatternHash(input);
      expect(hash1).toBe(hash2);
    });

    it("different inputs produce different hashes", () => {
      const hash1 = monitor.computePatternHash("DROP TABLE users");
      const hash2 = monitor.computePatternHash("SELECT * FROM users");
      expect(hash1).not.toBe(hash2);
    });

    it("normalizes whitespace before hashing", () => {
      const hash1 = monitor.computePatternHash("DROP   TABLE   users");
      const hash2 = monitor.computePatternHash("DROP TABLE users");
      expect(hash1).toBe(hash2);
    });

    it("is case-insensitive in normalization", () => {
      const hash1 = monitor.computePatternHash("DROP TABLE USERS");
      const hash2 = monitor.computePatternHash("drop table users");
      expect(hash1).toBe(hash2);
    });

    it("truncates input to 500 characters before normalization", () => {
      // Two strings that are identical in their first 500 chars but differ after
      const prefix = "x".repeat(100);
      const a = prefix + "y".repeat(400) + "AAAA"; // first 500: x*100 + y*400
      const b = prefix + "y".repeat(400) + "BBBB"; // first 500: x*100 + y*400 (same)
      const hashA = monitor.computePatternHash(a);
      const hashB = monitor.computePatternHash(b);
      // They should be the same because only first 500 chars are used
      expect(hashA).toBe(hashB);
    });

    it("returns a 16-character hex string", () => {
      const hash = monitor.computePatternHash("test content");
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe("record()", () => {
    it("creates a new record on first call", () => {
      expect(monitor.patternCount).toBe(0);

      const record = monitor.record(
        "DROP TABLE users",
        "injection",
        ["ab-1"],
        5000,
        200,
        true,
      );

      expect(monitor.patternCount).toBe(1);
      expect(record.callCount).toBe(1);
      expect(record.successCount).toBe(1);
      expect(record.failureCount).toBe(0);
      expect(record.totalLatencyUs).toBe(5000);
      expect(record.totalTokens).toBe(200);
      expect(record.category).toBe("injection");
      expect(record.resolvedBy).toEqual(["ab-1"]);
      expect(record.vaccinated).toBe(false);
      expect(record.vaccineAntibodyId).toBeNull();
      expect(record.firstSeen).toBeTruthy();
      expect(record.lastSeen).toBeTruthy();
    });

    it("updates existing record on subsequent calls for the same pattern", () => {
      const content = "malicious input payload here";
      monitor.record(content, "jailbreak", ["ab-1"], 1000, 50, true);
      expect(monitor.patternCount).toBe(1);

      const record = monitor.record(content, "jailbreak", ["ab-2"], 2000, 75, true);
      expect(monitor.patternCount).toBe(1); // Still only one pattern

      expect(record.callCount).toBe(2);
      expect(record.successCount).toBe(2);
      expect(record.failureCount).toBe(0);
      expect(record.totalLatencyUs).toBe(3000); // 1000 + 2000
      expect(record.totalTokens).toBe(125); // 50 + 75
      // resolvedBy should deduplicate
      expect(record.resolvedBy.sort()).toEqual(["ab-1", "ab-2"]);
    });

    it("tracks failures separately from successes", () => {
      const content = "attack pattern";
      monitor.record(content, "injection", ["ab-1"], 1000, 50, true);
      monitor.record(content, "injection", ["ab-1"], 1000, 50, false);
      monitor.record(content, "injection", ["ab-1"], 1000, 50, false);

      const record = monitor.record(content, "injection", ["ab-1"], 1000, 50, true);

      expect(record.callCount).toBe(4);
      expect(record.successCount).toBe(2);
      expect(record.failureCount).toBe(2);
    });

    it("uses normalized hash so minor whitespace differences match", () => {
      monitor.record("DROP   TABLE   users", "injection", ["ab-1"], 1000, 50, true);
      const record = monitor.record("DROP TABLE users", "injection", ["ab-1"], 1000, 50, true);

      // Should be the same record since whitespace is normalized
      expect(monitor.patternCount).toBe(1);
      expect(record.callCount).toBe(2);
    });

    it("sample field is truncated to 200 characters", () => {
      const longContent = "x".repeat(500);
      const record = monitor.record(longContent, "test", [], 0, 0, true);
      expect(record.sample.length).toBeLessThanOrEqual(200);
    });

    it("different content categories create separate records", () => {
      monitor.record("DROP TABLE", "injection", ["ab-1"], 1000, 50, true);
      monitor.record("BYPASS FILTER", "jailbreak", ["ab-2"], 2000, 100, true);

      expect(monitor.patternCount).toBe(2);
    });
  });

  describe("shouldVaccinate()", () => {
    function makeRecord(overrides: Partial<CostRecord> = {}): CostRecord {
      return {
        patternHash: "abc123",
        sample: "test",
        category: "injection",
        resolvedBy: ["ab-1"],
        callCount: 10,
        totalLatencyUs: 5_000_000,
        totalTokens: 10_000,
        successCount: 9,
        failureCount: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        vaccinated: false,
        vaccineAntibodyId: null,
        ...overrides,
      };
    }

    it("returns false when below minSamples", () => {
      const record = makeRecord({ callCount: 3 }); // minSamples is 5
      expect(monitor.shouldVaccinate(record)).toBe(false);
    });

    it("returns false when below minSuccessRate", () => {
      const record = makeRecord({ callCount: 10, successCount: 3, failureCount: 7 });
      // successRate = 3/10 = 0.3, below 0.7 threshold
      expect(monitor.shouldVaccinate(record)).toBe(false);
    });

    it("returns false when both latency and tokens are below thresholds", () => {
      const record = makeRecord({
        callCount: 10,
        successCount: 8,
        totalLatencyUs: 10_000, // avg = 1_000, far below 2_000_000 threshold
        totalTokens: 10_000, // avg = 1_000, below 4_000 threshold
      });
      expect(monitor.shouldVaccinate(record)).toBe(false);
    });

    it("returns true when latency exceeds threshold", () => {
      const record = makeRecord({
        callCount: 10,
        successCount: 8,
        totalLatencyUs: 30_000_000, // avg = 3_000_000, above 2_000_000 threshold
        totalTokens: 10_000, // avg = 1_000, below token threshold
      });
      expect(monitor.shouldVaccinate(record)).toBe(true);
    });

    it("returns true when tokens exceed threshold", () => {
      const record = makeRecord({
        callCount: 10,
        successCount: 8,
        totalLatencyUs: 10_000, // avg = 1_000, below latency threshold
        totalTokens: 50_000, // avg = 5_000, above 4_000 threshold
      });
      expect(monitor.shouldVaccinate(record)).toBe(true);
    });

    it("returns true when both latency and tokens exceed thresholds", () => {
      const record = makeRecord({
        callCount: 10,
        successCount: 8,
        totalLatencyUs: 30_000_000,
        totalTokens: 50_000,
      });
      expect(monitor.shouldVaccinate(record)).toBe(true);
    });

    it("returns false when already vaccinated", () => {
      const record = makeRecord({ vaccinated: true });
      expect(monitor.shouldVaccinate(record)).toBe(false);
    });

    it("returns false when successRate exactly at threshold (at least, not above)", () => {
      // minSuccessRate is 0.7. At exactly 0.7, should it vaccinate?
      // The code does: successRate < minSuccessRate → return false
      // So >= 0.7 passes the rate check
      const record = makeRecord({
        callCount: 10,
        successCount: 7,
        totalLatencyUs: 30_000_000,
        totalTokens: 10_000,
      });
      expect(monitor.shouldVaccinate(record)).toBe(true);
    });
  });

  describe("markVaccinated()", () => {
    it("sets vaccinated flag and vaccineAntibodyId", () => {
      const content = "attack to vaccinate";
      monitor.record(content, "injection", ["ab-1"], 1000, 50, true);
      const hash = monitor.computePatternHash(content);

      monitor.markVaccinated(hash, "new-ab-42");

      const record = monitor.get(hash);
      expect(record).toBeTruthy();
      expect(record!.vaccinated).toBe(true);
      expect(record!.vaccineAntibodyId).toBe("new-ab-42");
    });

    it("does nothing for non-existent hash", () => {
      // Should not throw
      monitor.markVaccinated("nonexistent-hash", "ab-1");
      expect(monitor.patternCount).toBe(0);
    });
  });

  describe("get() and list()", () => {
    it("get() returns undefined for unknown hash", () => {
      expect(monitor.get("unknown")).toBeUndefined();
    });

    it("get() returns the record for a known hash", () => {
      const content = "test content";
      monitor.record(content, "test", [], 0, 0, true);
      const hash = monitor.computePatternHash(content);
      const record = monitor.get(hash);
      expect(record).toBeTruthy();
      expect(record!.patternHash).toBe(hash);
    });

    it("list() returns all records", () => {
      monitor.record("content a", "cat-a", [], 0, 0, true);
      monitor.record("content b", "cat-b", [], 0, 0, true);
      monitor.record("content c", "cat-c", [], 0, 0, false);

      expect(monitor.list()).toHaveLength(3);
    });

    it("patternCount reflects number of unique patterns", () => {
      expect(monitor.patternCount).toBe(0);
      monitor.record("a", "test", [], 0, 0, true);
      expect(monitor.patternCount).toBe(1);
      monitor.record("b", "test", [], 0, 0, true);
      expect(monitor.patternCount).toBe(2);
      monitor.record("a", "test", [], 0, 0, true); // same as first, not new
      expect(monitor.patternCount).toBe(2);
    });
  });
});
