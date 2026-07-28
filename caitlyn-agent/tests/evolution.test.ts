/**
 * Tests for evolution pipeline — MemoryBank, CostMonitor, ShmEngine,
 * AffinityMaturation, and VaccinationPipeline.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  MemoryBank,
  CostMonitor,
  ShmEngine,
  AffinityMaturation,
  VaccinationPipeline,
} from "../src/evolution/index.js";
import type {
  Antibody,
  CostRecord,
  LabeledSample,
  MemoryEntry,
  VaccinationConfig,
  VaccinationResult,
} from "../src/evolution/types.js";

// ── Test Helpers ────────────────────────────────────────────────────

function makeAntibody(overrides: Partial<Antibody> = {}): Antibody {
  return {
    id: "ab-test-1",
    name: "Test Antibody",
    description: "Test description",
    category: "injection",
    tier: 1,
    prompt: "Detect SQL injection attacks.",
    threshold: 0.7,
    status: "active",
    signatures: ["DROP TABLE"],
    stats: {
      totalScans: 0,
      truePositives: 0,
      falsePositives: 0,
      avgLatencyUs: 0,
    },
    ...overrides,
  };
}

function makeMockLlm(response: string) {
  return async (_system: string, _user: string): Promise<string> => response;
}

// ── MemoryBank Tests ────────────────────────────────────────────────

describe("MemoryBank", () => {
  let bank: MemoryBank;

  beforeEach(() => {
    bank = new MemoryBank();
  });

  it("starts with zero entries", () => {
    expect(bank.size).toBe(0);
  });

  it("add() stores exact-pattern entries and check() finds them", () => {
    const entry: MemoryEntry = {
      id: "mem-1",
      pattern: "DROP TABLE users",
      signatureType: "exact",
      category: "injection",
      hitCount: 0,
      createdAt: new Date().toISOString(),
    };

    bank.add(entry);
    expect(bank.size).toBe(1);

    const match = bank.check("some content with DROP TABLE users inside");
    expect(match.kind).toBe("exact");
    if (match.kind === "exact") {
      expect(match.entry.id).toBe("mem-1");
      expect(match.entry.hitCount).toBe(1);
    }
  });

  it("check() returns 'none' when no pattern matches", () => {
    const entry: MemoryEntry = {
      id: "mem-2",
      pattern: "DROP TABLE",
      signatureType: "exact",
      category: "injection",
      hitCount: 0,
      createdAt: new Date().toISOString(),
    };

    bank.add(entry);
    const match = bank.check("completely safe content");
    expect(match.kind).toBe("none");
  });

  it("add() stores regex patterns and check() matches them", () => {
    const entry: MemoryEntry = {
      id: "mem-regex-1",
      pattern: "SELECT .* FROM .* WHERE",
      signatureType: "regex",
      category: "injection",
      hitCount: 0,
      createdAt: new Date().toISOString(),
    };

    bank.add(entry);
    expect(bank.size).toBe(1);

    const match = bank.check("SELECT * FROM users WHERE id = 1");
    expect(match.kind).toBe("exact");
    if (match.kind === "exact") {
      expect(match.entry.id).toBe("mem-regex-1");
    }
  });

  it("regex patterns are case-insensitive", () => {
    bank.add({
      id: "mem-ci",
      pattern: "DROP TABLE",
      signatureType: "regex",
      category: "injection",
      hitCount: 0,
      createdAt: new Date().toISOString(),
    });

    const match = bank.check("drop table users");
    expect(match.kind).toBe("exact");
  });

  it("exact patterns require substring match, not full-string match", () => {
    bank.add({
      id: "mem-sub",
      pattern: "malicious",
      signatureType: "exact",
      category: "jailbreak",
      hitCount: 0,
      createdAt: new Date().toISOString(),
    });

    const match = bank.check("prefix-malicious-suffix");
    expect(match.kind).toBe("exact");
  });

  it("check() returns first match and increments hitCount", () => {
    bank.add({
      id: "mem-first",
      pattern: "alpha",
      signatureType: "exact",
      category: "test",
      hitCount: 0,
      createdAt: new Date().toISOString(),
    });
    bank.add({
      id: "mem-second",
      pattern: "beta",
      signatureType: "exact",
      category: "test",
      hitCount: 0,
      createdAt: new Date().toISOString(),
    });

    const match = bank.check("content with alpha and beta");
    expect(match.kind).toBe("exact");
    if (match.kind === "exact") {
      expect(match.entry.id).toBe("mem-first");
      expect(match.entry.hitCount).toBe(1);
    }
  });

  it("list() returns all entries", () => {
    bank.add({
      id: "a",
      pattern: "pat-a",
      signatureType: "exact",
      category: "test",
      hitCount: 0,
      createdAt: new Date().toISOString(),
    });
    bank.add({
      id: "b",
      pattern: "pat-b",
      signatureType: "exact",
      category: "test",
      hitCount: 0,
      createdAt: new Date().toISOString(),
    });

    expect(bank.list()).toHaveLength(2);
  });

  it("remove() deletes an entry", () => {
    bank.add({
      id: "to-remove",
      pattern: "test",
      signatureType: "exact",
      category: "test",
      hitCount: 0,
      createdAt: new Date().toISOString(),
    });
    expect(bank.size).toBe(1);

    bank.remove("to-remove");
    expect(bank.size).toBe(0);
    expect(bank.check("test")).toEqual({ kind: "none" });
  });
});

// ── CostMonitor Tests ───────────────────────────────────────────────

describe("CostMonitor", () => {
  const config = {
    minSamples: 3,
    minSuccessRate: 0.5,
    latencyThresholdUs: 100_000,
    tokenThreshold: 50,
  };

  let monitor: CostMonitor;

  beforeEach(() => {
    monitor = new CostMonitor(config);
  });

  it("starts with zero patterns", () => {
    expect(monitor.patternCount).toBe(0);
  });

  it("record() creates a new CostRecord on first call", () => {
    const record = monitor.record(
      "malicious content here",
      "injection",
      ["ab-1"],
      5000,
      12,
      true,
    );

    expect(record.callCount).toBe(1);
    expect(record.successCount).toBe(1);
    expect(record.failureCount).toBe(0);
    expect(record.totalLatencyUs).toBe(5000);
    expect(record.totalTokens).toBe(12);
    expect(record.category).toBe("injection");
    expect(record.vaccinated).toBe(false);
    expect(record.patternHash).toHaveLength(16);
  });

  it("record() accumulates stats on repeated calls with same content", () => {
    const content = "DROP TABLE students; --";
    monitor.record(content, "injection", ["ab-1"], 1000, 5, true);
    const record = monitor.record(content, "injection", ["ab-2"], 2000, 10, true);

    expect(record.callCount).toBe(2);
    expect(record.successCount).toBe(2);
    expect(record.failureCount).toBe(0);
    expect(record.totalLatencyUs).toBe(3000);
    expect(record.totalTokens).toBe(15);
    // resolvedBy deduplicates
    expect(record.resolvedBy).toContain("ab-1");
    expect(record.resolvedBy).toContain("ab-2");
  });

  it("record() tracks failures separately", () => {
    const content = "bad input";
    monitor.record(content, "jailbreak", [], 1000, 5, false);
    monitor.record(content, "jailbreak", [], 2000, 8, false);

    const record = monitor.get(monitor.computePatternHash(content))!;
    expect(record.successCount).toBe(0);
    expect(record.failureCount).toBe(2);
  });

  it("computePatternHash() produces consistent hashes for same content", () => {
    const hash1 = monitor.computePatternHash("DROP TABLE users;");
    const hash2 = monitor.computePatternHash("DROP TABLE users;");
    expect(hash1).toBe(hash2);
  });

  it("computePatternHash() normalizes whitespace", () => {
    const hash1 = monitor.computePatternHash("a   b\tc");
    const hash2 = monitor.computePatternHash("a b c");
    expect(hash1).toBe(hash2);
  });

  it("computePatternHash() is case-insensitive", () => {
    const hash1 = monitor.computePatternHash("DROP TABLE");
    const hash2 = monitor.computePatternHash("drop table");
    expect(hash1).toBe(hash2);
  });

  it("shouldVaccinate() returns false when callCount is below minSamples", () => {
    const record = monitor.record(
      "test",
      "injection",
      [],
      200_000, // high latency
      100,     // high tokens
      true,
    );
    // Only 1 call, minSamples = 3
    expect(monitor.shouldVaccinate(record)).toBe(false);
  });

  it("shouldVaccinate() returns false when success rate is below threshold", () => {
    const content = "test";
    // 3 calls, 1 success = 33% success rate < 50% threshold
    monitor.record(content, "injection", [], 200_000, 100, true);
    monitor.record(content, "injection", [], 200_000, 100, false);
    monitor.record(content, "injection", [], 200_000, 100, false);

    const record = monitor.get(monitor.computePatternHash(content))!;
    expect(record.callCount).toBe(3);
    expect(monitor.shouldVaccinate(record)).toBe(false);
  });

  it("shouldVaccinate() returns true when latency exceeds threshold", () => {
    const content = "test-high-latency";
    // 3 calls, all success, avg latency = 200k > 100k threshold
    monitor.record(content, "injection", [], 200_000, 10, true);
    monitor.record(content, "injection", [], 200_000, 10, true);
    monitor.record(content, "injection", [], 200_000, 10, true);

    const record = monitor.get(monitor.computePatternHash(content))!;
    expect(monitor.shouldVaccinate(record)).toBe(true);
  });

  it("shouldVaccinate() returns true when token usage exceeds threshold", () => {
    const content = "test-high-tokens";
    // 3 calls, all success, avg tokens = 60 > 50 threshold
    monitor.record(content, "injection", [], 10_000, 60, true);
    monitor.record(content, "injection", [], 10_000, 60, true);
    monitor.record(content, "injection", [], 10_000, 60, true);

    const record = monitor.get(monitor.computePatternHash(content))!;
    expect(monitor.shouldVaccinate(record)).toBe(true);
  });

  it("shouldVaccinate() returns false when already vaccinated", () => {
    const content = "test-vax";
    monitor.record(content, "injection", [], 200_000, 100, true);
    monitor.record(content, "injection", [], 200_000, 100, true);
    monitor.record(content, "injection", [], 200_000, 100, true);

    const hash = monitor.computePatternHash(content);
    monitor.markVaccinated(hash, "vax-ab-1");

    const record = monitor.get(hash)!;
    expect(record.vaccinated).toBe(true);
    expect(monitor.shouldVaccinate(record)).toBe(false);
  });

  it("markVaccinated() sets vaccinated flag and antibody id", () => {
    const content = "test-mark";
    monitor.record(content, "injection", [], 1000, 5, true);
    const hash = monitor.computePatternHash(content);

    monitor.markVaccinated(hash, "vax-ab-42");
    const record = monitor.get(hash)!;
    expect(record.vaccinated).toBe(true);
    expect(record.vaccineAntibodyId).toBe("vax-ab-42");
  });
});

// ── ShmEngine Tests ─────────────────────────────────────────────────

describe("ShmEngine", () => {
  let engine: ShmEngine;

  beforeEach(() => {
    engine = new ShmEngine(0.8);
  });

  it("starts with base temperature", () => {
    expect(engine.temperature).toBe(0.8);
    expect(engine.baseTemperature).toBe(0.8);
  });

  it("default base temperature is 0.8", () => {
    const e = new ShmEngine();
    expect(e.temperature).toBe(0.8);
  });

  it("recordSuccess() increases temperature after 3 consecutive successes", () => {
    engine.recordSuccess();
    expect(engine.temperature).toBe(0.8); // 1 success: no change

    engine.recordSuccess();
    expect(engine.temperature).toBe(0.8); // 2 successes: no change

    engine.recordSuccess();
    expect(engine.temperature).toBe(0.9); // 3 successes: +0.1
  });

  it("recordSuccess() does not exceed TEMPERATURE_MAX", () => {
    // Max is 0.95. Start at 0.9, need 3 successes to get to 1.0, but max caps at 0.95.
    engine = new ShmEngine(0.9);
    engine.recordSuccess();
    engine.recordSuccess();
    engine.recordSuccess();
    expect(engine.temperature).toBe(0.95); // capped
  });

  it("recordFailure() immediately decreases temperature", () => {
    engine.recordFailure();
    expect(engine.temperature).toBeCloseTo(0.7); // 0.8 - 0.1
  });

  it("recordFailure() does not go below TEMPERATURE_MIN", () => {
    // Min is 0.3. Record enough failures to drive below it.
    engine.recordFailure(); // 0.7
    engine.recordFailure(); // 0.6
    engine.recordFailure(); // 0.5
    engine.recordFailure(); // 0.4
    engine.recordFailure(); // 0.3
    engine.recordFailure(); // should not go lower
    expect(engine.temperature).toBe(0.3);
  });

  it("consecutive success counter resets after failure", () => {
    engine.recordSuccess();
    engine.recordSuccess();
    engine.recordFailure(); // resets success counter
    engine.recordSuccess();
    // Two more successes after reset: still only 2 consecutive, no temp change
    expect(engine.temperature).toBeCloseTo(0.7); // 0.8 - 0.1 from failure
  });

  it("consecutive failure counter resets after success", () => {
    engine.recordFailure(); // 0.7
    engine.recordSuccess();
    // Success resets failure counter but doesn't trigger temp change (only 1)
    expect(engine.temperature).toBeCloseTo(0.7);
  });

  it("mutate() returns empty array on parse failure", async () => {
    const mockLlm = makeMockLlm("not valid JSON at all");
    const parent = makeAntibody();
    const result = await engine.mutate(parent, ["sample1"], 3, mockLlm);
    expect(result).toEqual([]);
  });

  it("mutate() parses valid SHM JSON output into antibodies", async () => {
    const shmOutput = JSON.stringify([
      {
        name: "Variant 1",
        description: "First variant",
        prompt: "Detect SQL injection with improved accuracy.",
        threshold: 0.75,
        mutation_operations: ["substitute_word", "widen_context"],
        new_signatures: ["SELECT .* FROM", "UNION SELECT"],
      },
    ]);

    const mockLlm = makeMockLlm(shmOutput);
    const parent = makeAntibody({
      id: "parent-1",
      category: "injection",
    });

    const result = await engine.mutate(parent, ["sample1"], 1, mockLlm);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Variant 1");
    expect(result[0].description).toBe("First variant");
    expect(result[0].prompt).toBe("Detect SQL injection with improved accuracy.");
    expect(result[0].threshold).toBe(0.75);
    expect(result[0].category).toBe("injection");
    expect(result[0].tier).toBe(1);
    expect(result[0].status).toBe("candidate");
    expect(result[0].signatures).toEqual(["SELECT .* FROM", "UNION SELECT"]);
    expect(result[0].id).toContain("parent-1-v");
  });

  it("mutate() sets signatures to undefined when empty", async () => {
    const shmOutput = JSON.stringify([
      {
        name: "Variant",
        description: "No sigs",
        prompt: "Check.",
        threshold: 0.5,
        mutation_operations: [],
        new_signatures: [],
      },
    ]);

    const mockLlm = makeMockLlm(shmOutput);
    const parent = makeAntibody();
    const result = await engine.mutate(parent, ["sample"], 1, mockLlm);

    expect(result[0].signatures).toBeUndefined();
  });
});

// ── AffinityMaturation Tests ────────────────────────────────────────

describe("AffinityMaturation", () => {
  const mustDetect: LabeledSample[] = [
    { content: "DROP TABLE users; --", isAttack: true },
    { content: "UNION SELECT password FROM users", isAttack: true },
  ];

  const shouldDetect: LabeledSample[] = [
    { content: "1=1 always true", isAttack: true },
  ];

  const mustNotDetect: LabeledSample[] = [
    { content: "Hello, how can I help you?", isAttack: false },
    { content: "What is the weather today?", isAttack: false },
  ];

  it("evaluate() scores a perfect detector correctly", async () => {
    const maturation = new AffinityMaturation();
    const candidates = [makeAntibody({ prompt: "perfect" })];

    // Scanner that always detects attacks and rejects benign
    const scanner = async (_prompt: string, content: string): Promise<[boolean, number]> => {
      const isAttack = content.includes("DROP") || content.includes("UNION") || content.includes("1=1");
      return [isAttack, isAttack ? 0.9 : 0.1];
    };

    const results = await maturation.evaluate(
      candidates, mustDetect, shouldDetect, mustNotDetect, scanner,
    );

    expect(results).toHaveLength(1);
    expect(results[0].truePositives).toBe(3); // 2 must + 1 should
    expect(results[0].falsePositives).toBe(0);
    expect(results[0].trueNegatives).toBe(2);
    expect(results[0].falseNegatives).toBe(0);
    expect(results[0].detectedMustDetect).toBe(true);
    expect(results[0].affinityScore).toBeGreaterThan(0.9);
  });

  it("evaluate() penalizes false positives", async () => {
    // Use heavier fpPenalty to make the penalty more visible
    const maturation = new AffinityMaturation({ fpPenalty: 0.8 });
    const candidates = [makeAntibody({ prompt: "overly-aggressive" })];

    // Scanner that flags everything as malicious
    const scanner = async (_prompt: string, _content: string): Promise<[boolean, number]> => {
      return [true, 0.99];
    };

    const results = await maturation.evaluate(
      candidates, mustDetect, shouldDetect, mustNotDetect, scanner,
    );

    expect(results[0].truePositives).toBe(3);
    expect(results[0].falsePositives).toBe(2); // flagged benign as malicious
    expect(results[0].trueNegatives).toBe(0);
    // With fpPenalty=0.8: score = 1.0*0.7 + 0.6*0.3 - (2/3)*0.8 ≈ 0.347
    expect(results[0].affinityScore).toBeLessThan(0.4);
  });

  it("evaluate() catches misses (false negatives)", async () => {
    const maturation = new AffinityMaturation();
    const candidates = [makeAntibody({ prompt: "too-strict" })];

    // Scanner that never flags anything
    const scanner = async (_prompt: string, _content: string): Promise<[boolean, number]> => {
      return [false, 0.1];
    };

    const results = await maturation.evaluate(
      candidates, mustDetect, shouldDetect, mustNotDetect, scanner,
    );

    expect(results[0].truePositives).toBe(0);
    expect(results[0].falseNegatives).toBe(3); // missed all attacks
    expect(results[0].falsePositives).toBe(0);
    expect(results[0].trueNegatives).toBe(2);
    expect(results[0].detectedMustDetect).toBe(false);
    expect(results[0].affinityScore).toBe(0);
  });

  it("selectSurvivors() filters by mustDetect and threshold", async () => {
    const maturation = new AffinityMaturation({ survivalThreshold: 0.5, maxSurvivors: 5 });

    // Good candidate: detects all attacks, no FPs
    const good = makeAntibody({ id: "good", prompt: "good-detector" });
    // Bad candidate: misses everything
    const bad = makeAntibody({ id: "bad", prompt: "bad-detector" });

    const scannerGood = async (_prompt: string, content: string): Promise<[boolean, number]> => {
      const isAttack = content.includes("DROP") || content.includes("UNION") || content.includes("1=1");
      return [isAttack, isAttack ? 0.9 : 0.1];
    };
    const scannerBad = async (_prompt: string, _content: string): Promise<[boolean, number]> => {
      return [false, 0];
    };

    const resultsGood = await maturation.evaluate(
      [good], mustDetect, shouldDetect, mustNotDetect, scannerGood,
    );
    const resultsBad = await maturation.evaluate(
      [bad], mustDetect, shouldDetect, mustNotDetect, scannerBad,
    );

    const survivors = maturation.selectSurvivors([...resultsGood, ...resultsBad]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].antibody.id).toBe("good");
  });

  it("selectSurvivors() respects maxSurvivors", async () => {
    const maturation = new AffinityMaturation({ survivalThreshold: 0.0, maxSurvivors: 1 });

    const a = makeAntibody({ id: "a", prompt: "detect-a" });
    const b = makeAntibody({ id: "b", prompt: "detect-b" });

    const scanner = async (_p: string, content: string): Promise<[boolean, number]> => {
      const isAttack = content.includes("DROP") || content.includes("UNION") || content.includes("1=1");
      return [isAttack, isAttack ? 0.9 : 0.1];
    };

    const results = await maturation.evaluate(
      [a, b], mustDetect, shouldDetect, mustNotDetect, scanner,
    );

    const survivors = maturation.selectSurvivors(results);
    expect(survivors).toHaveLength(1);
  });

  it("uses custom config in constructor", async () => {
    const maturation = new AffinityMaturation({
      recallWeight: 1.0,
      precisionWeight: 0.0,
      fpPenalty: 0.0,
      survivalThreshold: 0.0,
    });

    const candidates = [makeAntibody({ prompt: "recall-only" })];

    const scanner = async (_p: string, content: string): Promise<[boolean, number]> => {
      return [true, 1.0]; // flags everything: perfect recall, zero precision
    };

    const results = await maturation.evaluate(
      candidates, mustDetect, shouldDetect, mustNotDetect, scanner,
    );

    // With recallWeight=1.0, precisionWeight=0.0, fpPenalty=0.0:
    // recall = 3/3 = 1.0, precision = 3/5 = 0.6
    // score = 1.0 * 1.0 + 0.6 * 0.0 - (2/3) * 0.0 = 1.0
    expect(results[0].affinityScore).toBe(1.0);
  });
});

// ── VaccinationPipeline Tests ───────────────────────────────────────

describe("VaccinationPipeline", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createValsetDir(): string {
    const valsetDir = path.join(tmpDir, "valset");
    const attacksDir = path.join(valsetDir, "attacks");
    const benignDir = path.join(valsetDir, "benign");

    fs.mkdirSync(attacksDir, { recursive: true });
    fs.mkdirSync(benignDir, { recursive: true });

    // Create attack samples
    const attackLines = [
      JSON.stringify({ content: "DROP TABLE users; --" }) + "\n",
      JSON.stringify({ content: "1; DROP TABLE students; --" }) + "\n",
      JSON.stringify({ content: "UNION SELECT password FROM users" }) + "\n",
    ].join("");

    fs.writeFileSync(
      path.join(attacksDir, "agentdojo_all.jsonl"),
      attackLines,
    );

    // Create benign samples
    const benignLines = [
      JSON.stringify({ content: "What is the capital of France?" }) + "\n",
      JSON.stringify({ content: "Help me write a Python script to count words." }) + "\n",
    ].join("");

    fs.writeFileSync(
      path.join(benignDir, "agent_tasks.jsonl"),
      benignLines,
    );

    return valsetDir;
  }

  const pipelineConfig: VaccinationConfig = {
    minSamples: 1,
    minSuccessRate: 0.5,
    latencyThresholdUs: 100_000,
    tokenThreshold: 50,
    shmVariants: 2,
    shmBaseTemperature: 0.8,
    maxSurvivors: 3,
    affinityRecallWeight: 0.7,
    fpTolerance: 0.2,
  };

  it("vaccinate() returns empty when pattern not found in cost monitor", async () => {
    const pipeline = new VaccinationPipeline(pipelineConfig);
    const costMonitor = new CostMonitor({
      minSamples: 1,
      minSuccessRate: 0.5,
      latencyThresholdUs: 100_000,
      tokenThreshold: 50,
    });
    const memoryBank = new MemoryBank();
    const valsetDir = createValsetDir();

    const mockLlm = makeMockLlm("[]");
    const results = await pipeline.vaccinate(
      "nonexistent-hash",
      [makeAntibody()],
      costMonitor,
      memoryBank,
      mockLlm,
      valsetDir,
    );

    expect(results).toEqual([]);
  });

  it("vaccinate() with mock LLM returns variants that survive evaluation", async () => {
    const pipeline = new VaccinationPipeline(pipelineConfig);
    const costMonitor = new CostMonitor({
      minSamples: 1,
      minSuccessRate: 0.5,
      latencyThresholdUs: 100_000,
      tokenThreshold: 50,
    });
    const memoryBank = new MemoryBank();
    const valsetDir = createValsetDir();

    // Record a pattern
    const content = "DROP TABLE users; --";
    const record = costMonitor.record(content, "injection", [], 10_000, 5, true);
    const patternHash = record.patternHash;

    // LLM returns SHM variants (Phase 1 will succeed)
    const shmOutput = JSON.stringify([
      {
        name: "SHM Variant A",
        description: "Detects DROP TABLE patterns",
        prompt:
          "You are a security filter. Check if the content contains SQL DROP, DELETE, or TRUNCATE statements. " +
          "Respond ONLY: {\"verdict\":\"malicious\",\"confidence\":0.95,\"reason\":\"...\"} or " +
          "{\"verdict\":\"benign\",\"confidence\":0.05,\"reason\":\"...\"}",
        threshold: 0.7,
        mutation_operations: ["substitute"],
        new_signatures: ["DROP TABLE", "DROP DATABASE"],
      },
    ]);

    // LLM used both for SHM (Phase 1) and scanner (Phase 2)
    // Phase 2 scanner: LLM receives the variant prompt + JSON instruction
    // We need it to return valid JSON verdicts
    let callCount = 0;
    const mockLlm = async (_system: string, userPrompt: string): Promise<string> => {
      callCount++;
      if (callCount === 1) {
        // Phase 1: SHM variant generation
        return shmOutput;
      }
      // Phase 2: Scanner evaluation — userPrompt is the content being scanned
      // Return malicious for attack content, benign for safe content
      const isAttack =
        userPrompt.includes("DROP") ||
        userPrompt.includes("UNION") ||
        userPrompt.includes("1; DROP");
      return JSON.stringify({
        verdict: isAttack ? "malicious" : "benign",
        confidence: isAttack ? 0.95 : 0.05,
        reason: "test",
      });
    };

    const results = await pipeline.vaccinate(
      patternHash,
      [makeAntibody()],
      costMonitor,
      memoryBank,
      mockLlm,
      valsetDir,
    );

    // Should have at least one survivor
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].antibody.status).toBe("active");
    expect(results[0].affinityScore).toBeGreaterThan(0);
    expect(results[0].precision).toBeGreaterThan(0);
    expect(results[0].recall).toBeGreaterThan(0);

    // Memory entries should be created from signatures
    expect(results[0].memoryEntries.length).toBeGreaterThan(0);
    // Memory bank should contain those entries
    expect(memoryBank.size).toBeGreaterThan(0);
  });

  it("vaccinate() records SHM failure when no variants generated", async () => {
    const pipeline = new VaccinationPipeline(pipelineConfig);
    const costMonitor = new CostMonitor({
      minSamples: 1,
      minSuccessRate: 0.5,
      latencyThresholdUs: 100_000,
      tokenThreshold: 50,
    });
    const memoryBank = new MemoryBank();
    const valsetDir = createValsetDir();

    const content = "test content";
    const record = costMonitor.record(content, "injection", [], 10_000, 5, true);

    // SHM returns unparseable output → no variants
    const mockLlm = makeMockLlm("garbage output");
    const results = await pipeline.vaccinate(
      record.patternHash,
      [makeAntibody()],
      costMonitor,
      memoryBank,
      mockLlm,
      valsetDir,
    );

    // Should get empty results when SHM fails
    expect(results).toEqual([]);
  });
});
