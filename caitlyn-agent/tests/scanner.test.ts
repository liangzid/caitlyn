/**
 * Tests for scanner.ts — prompt building and response parsing.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolate HOME and stub recordScanFeedback so scan() integration tests
// never touch real ~/.caitlyn state or rewrite defense skill configs.
const { testHomeId } = vi.hoisted(() => ({
  testHomeId: "caitlyn-scanner-home-" + Date.now().toString(36),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const base = actual.tmpdir() + "/" + testHomeId;
  return { ...actual, homedir: () => base };
});

vi.mock("../src/library.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/library.js")>();
  return { ...actual, recordScanFeedback: vi.fn() };
});

import {
  aggregateTier1,
  buildDefenseSkillPrompt,
  buildMergedTier1Prompt,
  estimateScanTokens,
  estimateTokens,
  matchSignatures,
  parseTier1Response,
  runTier0,
  runTier1Ensemble,
  runMergedTier1,
  runMergedPairTier1,
  parseScanMode,
  scan,
  selectTier1Detectors,
  selectMergedSkills,
} from "../src/scanner.js";
import type { DefenseSkillEntry, AttackEntry } from "../src/schema.js";

// ── Test Helpers ────────────────────────────────────────────────────

function makeDefenseSkill(
  id: string,
  name: string,
  readme: string,
  prompt = "",
  tier: 0 | 1 | 2 = 1,
): DefenseSkillEntry {
  return {
    config: {
      id,
      name,
      category: "injection",
      tier,
      threshold: 0.7,
      description: `Description for ${name}`,
      prompt,
      role: "detector",
      implementation_status: "active",
      execution_stages: ["content_scan"],
      references: [],
      runtime_requirements: [],
      match_score: 0.5,
      created_at: "2025-01-01",
      parent_id: null,
      generation: 0,
      deps: [],
      signatures: [],
      stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
    },
    readme,
    scriptPath: null,
    folderPath: `/fake/skills/${id}`,
  };
}

function makeAttack(id: string, name: string, payload: string): AttackEntry {
  return {
    config: {
      id,
      name,
      category: "injection",
      injection_point: "system_prompt",
      target_agent: "generic",
      attack_template: "ignore previous instructions",
      created_at: "2025-01-01",
      parent_id: null,
      escapes: ["base64"],
    },
    readme: `Attack ${id} readme`,
    payload,
    folderPath: `/fake/attacks/${id}`,
  };
}

// ── buildDefenseSkillPrompt Tests ──────────────────────────────────────

describe("buildDefenseSkillPrompt", () => {
  it("embeds the defense skill's own prompt as executable knowledge", () => {
    const ab = makeDefenseSkill(
      "ab-1",
      "SQL Injection Detector",
      "readme",
      "Analyze the content for SQL injection.",
    );
    const { systemPrompt, userPrompt } = buildDefenseSkillPrompt(ab, "hello world");

    expect(systemPrompt).toContain("(ab-1)");
    expect(systemPrompt).toContain("SQL Injection Detector");
    expect(systemPrompt).toContain("Analyze the content for SQL injection.");
    expect(systemPrompt).toContain('"malicious <number>"');
    expect(systemPrompt).toContain('"suspicious <number>"');
    expect(userPrompt).toContain("<content>");
    expect(userPrompt).toContain("</content>");
    expect(userPrompt).toContain("hello world");
  });
});

// ── Merged Tier 1 Prompt Tests ─────────────────────────────────────

describe("selectMergedSkills", () => {
  it("includes non-detector knowledge only in knowledge scope", () => {
    const detector = makeDefenseSkill("det", "Det", "readme", "Detect.", 1);
    const nonDetector = makeDefenseSkill("hard", "Hard", "readme", "Harden.", 1);
    nonDetector.config.role = "non_detector";

    expect(selectMergedSkills([detector, nonDetector], "detectors").map((a) => a.config.id))
      .toEqual(["det"]);
    expect(selectMergedSkills([detector, nonDetector], "knowledge").map((a) => a.config.id).sort())
      .toEqual(["det", "hard"]);
  });

  it("excludes experimental and reference skills from runtime prompts", () => {
    const active = makeDefenseSkill("active", "Active", "readme", "Detect.", 1);
    const experimental = makeDefenseSkill("experimental", "Experimental", "readme", "Research.", 1);
    experimental.config.implementation_status = "experimental";
    const reference = makeDefenseSkill("reference", "Reference", "readme", "Research.", 1);
    reference.config.implementation_status = "reference";

    expect(selectMergedSkills([active, experimental, reference], "knowledge").map((a) => a.config.id))
      .toEqual(["active"]);
    expect(selectTier1Detectors([active, experimental, reference]).map((a) => a.config.id))
      .toEqual(["active"]);
  });
});

describe("buildMergedTier1Prompt", () => {
  it("embeds every tier>0 skill as knowledge in the META system prompt", () => {
    const detector = makeDefenseSkill("det", "Detector", "readme", "Detect X.", 1);
    const nonDetector = makeDefenseSkill("hard", "Hardener", "readme", "Harden Y.", 2);
    nonDetector.config.role = "non_detector";

    const { systemPrompt, userPrompt, skillIds } = buildMergedTier1Prompt(
      [detector, nonDetector],
      "hello world",
    );

    expect(skillIds).toEqual(["det", "hard"]);
    expect(systemPrompt).toContain("security filter for LLM agents");
    expect(systemPrompt).toContain("reference knowledge");
    expect(systemPrompt).toContain("[det] Detector");
    expect(systemPrompt).toContain("Detect X.");
    expect(systemPrompt).toContain("[hard] Hardener");
    expect(systemPrompt).toContain('"malicious <number>"');
    expect(userPrompt).toContain("<content>");
    expect(userPrompt).toContain("hello world");
  });

  it("restricts to detector skills in detector scope", () => {
    const detector = makeDefenseSkill("det", "Detector", "readme", "Detect X.", 1);
    const nonDetector = makeDefenseSkill("hard", "Hardener", "readme", "Harden Y.", 2);
    nonDetector.config.role = "non_detector";

    const { systemPrompt, skillIds } = buildMergedTier1Prompt(
      [detector, nonDetector],
      "x",
      "detectors",
    );
    expect(skillIds).toEqual(["det"]);
    expect(systemPrompt).not.toContain("[hard]");
  });
});

describe("runMergedTier1", () => {
  it("makes exactly one LLM call and returns a single verdict", async () => {
    const skills = [
      makeDefenseSkill("a", "A", "readme", "Detect A.", 1),
      makeDefenseSkill("b", "B", "readme", "Detect B.", 1),
    ];
    let calls = 0;
    let sawPrompt = "";
    const result = await runMergedTier1(skills, "content", async (system, user) => {
      calls += 1;
      sawPrompt = system;
      expect(user).toContain("<content>");
      return "malicious 0.91";
    });

    expect(calls).toBe(1);
    expect(result.defense_skill_id).toBe("merged-tier1");
    expect(result.verdict).toBe("malicious");
    expect(result.confidence).toBe(0.91);
    expect(result.reason).toContain("2 skills");
    expect(result.tokens).toBeGreaterThan(0);
    expect(sawPrompt).toContain("[a] A");
    expect(sawPrompt).toContain("[b] B");
  });

  it("captures USD cost reported by the LLM call", async () => {
    const skills = [makeDefenseSkill("a", "A", "readme", "Detect A.", 1)];
    const result = await runMergedTier1(skills, "content", async (_system, _user, onCost) => {
      onCost?.(0.00123);
      return "benign 0.1";
    });
    expect(result.cost_usd).toBeCloseTo(0.00123, 5);
  });
});

describe("runMergedPairTier1", () => {
  it("runs both merged scopes and OR-aggregates malicious votes", async () => {
    const skills = [
      makeDefenseSkill("a", "A", "readme", "Detect A.", 1),
      makeDefenseSkill("hard", "Hard", "readme", "Harden.", 1),
    ];
    skills[1].config.role = "non_detector";
    let calls = 0;
    const pair = await runMergedPairTier1(skills, "content", async (system) => {
      calls += 1;
      return system.includes("[a] A") && !system.includes("[hard] Hard")
        ? "malicious 0.91"
        : "benign 0.05";
    });

    expect(calls).toBe(2);
    expect(pair.results).toHaveLength(2);
    expect(pair.aggregated.verdict).toBe("malicious");
    expect(pair.aggregated.confidence).toBe(0.91);
    expect(pair.results[0]!.tokens + pair.results[1]!.tokens).toBeGreaterThan(0);
  });

  it("returns benign only when both merged calls are benign", async () => {
    const skills = [makeDefenseSkill("a", "A", "readme", "Detect A.", 1)];
    const pair = await runMergedPairTier1(skills, "content", async () => "benign 0.1");
    expect(pair.aggregated.verdict).toBe("benign");
  });
});

// ── Tier 1 Ensemble Tests ──────────────────────────────────────────

describe("selectTier1Detectors", () => {
  it("runs only detector-role tier 1/2 defense skills with a prompt", () => {
    const detectors = [
      makeDefenseSkill("good", "Good", "readme", "You are a detector.", 1),
      makeDefenseSkill("tier0", "T0", "readme", "prompt", 0),
      makeDefenseSkill("no-prompt", "No Prompt", "readme", "", 2),
    ];
    detectors[2].config.role = "non_detector";

    const selected = selectTier1Detectors(detectors);
    expect(selected.map((a) => a.config.id)).toEqual(["good"]);
  });
});

describe("runTier1Ensemble", () => {
  it("runs every detector independently and keeps per-defense-skill verdicts", async () => {
    const detectors = [
      makeDefenseSkill("a", "A", "readme", "Detect A.", 1),
      makeDefenseSkill("b", "B", "readme", "Detect B.", 2),
    ];
    const called: string[] = [];
    const results = await runTier1Ensemble(detectors, "content", async (system) => {
      called.push(system.includes("(a)") ? "a" : "b");
      return system.includes("(a)") ? "malicious 0.9" : "benign 0.1";
    });

    expect(called.sort()).toEqual(["a", "b"]);
    const byId = new Map(results.map((r) => [r.defense_skill_id, r]));
    expect(byId.get("a")?.verdict).toBe("malicious");
    expect(byId.get("a")?.confidence).toBe(0.9);
    expect(byId.get("b")?.verdict).toBe("benign");
    expect(byId.get("a")?.tokens).toBeGreaterThan(0);
  });

  it("records per-detector errors and throws when every detector fails", async () => {
    const detectors = [makeDefenseSkill("a", "A", "readme", "Detect A.", 1)];
    await expect(
      runTier1Ensemble(detectors, "content", async () => {
        throw new Error("llm down");
      }),
    ).rejects.toThrow("All Tier 1 detectors failed");
  });

  it("returns partial results when only some detectors fail", async () => {
    const detectors = [
      makeDefenseSkill("a", "A", "readme", "Detect A.", 1),
      makeDefenseSkill("b", "B", "readme", "Detect B.", 1),
    ];
    const results = await runTier1Ensemble(detectors, "content", async (system) => {
      if (system.includes("(a)")) throw new Error("down");
      return "suspicious 0.5";
    });
    const byId = new Map(results.map((r) => [r.defense_skill_id, r]));
    expect(byId.get("a")?.error).toContain("down");
    expect(byId.get("b")?.verdict).toBe("suspicious");
  });

  it("times out a hung detector call without blocking the ensemble", async () => {
    const detectors = [
      makeDefenseSkill("slow", "Slow", "readme", "Detect slow.", 1),
      makeDefenseSkill("fast", "Fast", "readme", "Detect fast.", 1),
    ];
    const results = await runTier1Ensemble(detectors, "content", async (system) => {
      if (system.includes("slow")) {
        return new Promise<string>(() => {});
      }
      return "benign 0.1";
    }, undefined, { timeoutMs: 50 });

    const byId = new Map(results.map((r) => [r.defense_skill_id, r]));
    expect(byId.get("slow")?.error).toContain("timeout after 50ms");
    expect(byId.get("fast")?.verdict).toBe("benign");
  });

  it("limits Tier 1 concurrency to maxParallel", async () => {
    const detectors = Array.from({ length: 5 }, (_, i) =>
      makeDefenseSkill(`p${i}`, `P${i}`, "readme", "Detect.", 1),
    );
    let active = 0;
    let maxActive = 0;
    const results = await runTier1Ensemble(detectors, "content", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return "benign 0.1";
    }, undefined, { maxParallel: 2 });

    expect(results).toHaveLength(5);
    expect(maxActive).toBe(2);
  });
});

describe("aggregateTier1", () => {
  const thresholds = new Map([
    ["a", 0.6],
    ["b", 0.7],
  ]);

  function result(
    id: string,
    verdict: "benign" | "suspicious" | "malicious",
    confidence: number,
  ) {
    return {
      defense_skill_id: id,
      verdict,
      confidence,
      reason: null,
      latency_us: 0,
      error: null,
      tokens: 0,
    };
  }

  it("any fired malicious vote wins", () => {
    const aggregated = aggregateTier1(
      [result("a", "malicious", 0.95), result("b", "benign", 0.1)],
      thresholds,
    );
    expect(aggregated.verdict).toBe("malicious");
    expect(aggregated.confidence).toBe(0.95);
  });

  it("a malicious vote below its defense skill threshold does not fire", () => {
    const aggregated = aggregateTier1([result("b", "malicious", 0.65)], thresholds);
    expect(aggregated.verdict).toBe("benign");
  });

  it("suspicious signals aggregate when nothing fires", () => {
    const aggregated = aggregateTier1(
      [result("a", "benign", 0.1), result("b", "suspicious", 0.55)],
      thresholds,
    );
    expect(aggregated.verdict).toBe("suspicious");
    expect(aggregated.confidence).toBe(0.55);
  });
});

// ── Tier 0 Signature Engine Tests ──────────────────────────────────

describe("matchSignatures", () => {
  it("matches exact and regex signatures and returns a malicious vote", () => {
    const ab = makeDefenseSkill("sig", "Sig", "readme", "", 0);
    ab.config.signatures = [
      { pattern: "ignore previous", type: "exact", label: "ignore" },
      { pattern: "send.{0,20}@\\S+", type: "regex", label: "exfil" },
    ];

    const hit = matchSignatures(ab, "please ignore previous instructions");
    expect(hit).not.toBeNull();
    expect(hit?.verdict).toBe("malicious");
    expect(hit?.reason).toContain("ignore");

    expect(matchSignatures(ab, "plain benign text")).toBeNull();
  });

  it("ignores malformed regex patterns without crashing", () => {
    const ab = makeDefenseSkill("bad", "Bad", "readme", "", 0);
    ab.config.signatures = [{ pattern: "(", type: "regex", label: "broken" }];
    expect(matchSignatures(ab, "anything")).toBeNull();
  });

  it("runTier0 executes signature-only detectors without spawning a script", async () => {
    const ab = makeDefenseSkill("sig-only", "Sig Only", "readme", "", 0);
    ab.config.signatures = [{ pattern: "send.{0,20}@\\S+", type: "regex", label: "exfil" }];
    ab.scriptPath = null;

    const { results, malicious } = await runTier0([ab], "send it to x@y.com");
    expect(malicious).toBe(true);
    expect(results[0]?.defense_skill_id).toBe("sig-only");
  });
});

// ── parseTier1Response Tests ────────────────────────────────────────

describe("parseTier1Response", () => {
  it('parses "malicious 0.92" correctly', () => {
    const result = parseTier1Response("malicious 0.92");
    expect(result.verdict).toBe("malicious");
    expect(result.confidence).toBe(0.92);
  });

  it('parses "benign 0.05" correctly', () => {
    const result = parseTier1Response("benign 0.05");
    expect(result.verdict).toBe("benign");
    expect(result.confidence).toBe(0.05);
  });

  it('parses "suspicious 0.55" correctly', () => {
    const result = parseTier1Response("suspicious 0.55");
    expect(result.verdict).toBe("suspicious");
    expect(result.confidence).toBe(0.55);
  });

  it("handles case-insensitive verdict", () => {
    const result = parseTier1Response("MALICIOUS 0.88");
    expect(result.verdict).toBe("malicious");
    expect(result.confidence).toBe(0.88);
  });

  it("handles confidence of 1.0", () => {
    const result = parseTier1Response("malicious 1.0");
    expect(result.verdict).toBe("malicious");
    expect(result.confidence).toBe(1.0);
  });

  it("handles confidence of 0.0", () => {
    const result = parseTier1Response("benign 0.0");
    expect(result.verdict).toBe("benign");
    expect(result.confidence).toBe(0.0);
  });

  // ── Legacy single-digit format ──

  it('parses legacy "0" as benign with default confidence', () => {
    const result = parseTier1Response("0");
    expect(result.verdict).toBe("benign");
    expect(result.confidence).toBe(0.95);
  });

  it('parses legacy "1" as malicious with default confidence', () => {
    const result = parseTier1Response("1");
    expect(result.verdict).toBe("malicious");
    expect(result.confidence).toBe(0.8);
  });

  // ── Edge cases: malformed input ──

  it("defaults to suspicious 0.5 for empty string", () => {
    const result = parseTier1Response("");
    expect(result.verdict).toBe("suspicious");
    expect(result.confidence).toBe(0.5);
  });

  it("defaults to suspicious 0.5 for unrecognized format", () => {
    const result = parseTier1Response("completely bogus input!!!");
    expect(result.verdict).toBe("suspicious");
    expect(result.confidence).toBe(0.5);
  });

  it("defaults to suspicious 0.5 for verdict-only without confidence", () => {
    const result = parseTier1Response("malicious");
    expect(result.verdict).toBe("suspicious");
    expect(result.confidence).toBe(0.5);
  });

  it("defaults to suspicious 0.5 for unknown verdict with valid confidence", () => {
    // "dangerous" is not in the enum — regex won't match
    const result = parseTier1Response("dangerous 0.95");
    expect(result.verdict).toBe("suspicious");
    expect(result.confidence).toBe(0.5);
  });

  it("defaults to suspicious 0.5 for whitespace-only input", () => {
    const result = parseTier1Response("   ");
    expect(result.verdict).toBe("suspicious");
    expect(result.confidence).toBe(0.5);
  });

  it("handles extra whitespace between tokens", () => {
    const result = parseTier1Response("malicious   0.75");
    expect(result.verdict).toBe("malicious");
    expect(result.confidence).toBe(0.75);
  });

  it("does not match with trailing whitespace (^ and $ anchors)", () => {
    const result = parseTier1Response("benign 0.42  ");
    expect(result.verdict).toBe("suspicious");
    expect(result.confidence).toBe(0.5); // falls through to default
  });

  it("does not match with leading whitespace (^ anchor)", () => {
    const result = parseTier1Response("  suspicious 0.33");
    expect(result.verdict).toBe("suspicious");
    expect(result.confidence).toBe(0.5); // falls through to default
  });

  it("does not match multiline responses", () => {
    // Regex uses ^ anchor, so content after newline breaks the match
    const result = parseTier1Response("malicious 0.99\nsome extra text");
    expect(result.verdict).toBe("suspicious");
    expect(result.confidence).toBe(0.5);
  });
});

describe("token estimation", () => {
  it("estimates tokens as ceil(length / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdef")).toBe(2);
  });

  it("sums system, user and output tokens for a scan", () => {
    const total = estimateScanTokens("a".repeat(100), "b".repeat(100), "c".repeat(20));
    expect(total).toBe(25 + 25 + 5);
  });
});

describe("scan() cost accounting", () => {
  it("reports the summed per-detector prompt + output tokens for Tier 1", async () => {
    const ab = makeDefenseSkill("cost", "Cost", "readme", "You are a detector.", 1);
    const { systemPrompt, userPrompt } = buildDefenseSkillPrompt(ab, "hello");
    const output = "benign 0.95";
    let calls = 0;
    const result = await scan({
      defenseSkills: [ab],
      attacks: [],
      content: "hello",
      llmCall: async () => {
        calls += 1;
        return output;
      },
    });
    expect(result.tier).toBe(1);
    expect(calls).toBe(1);
    expect(result.total_tokens).toBe(estimateScanTokens(systemPrompt, userPrompt, output));
    expect(result.total_tokens).toBeGreaterThan(1); // no longer hardcoded +1
  });

  it("skips the LLM entirely when the library has no Tier 1 detectors", async () => {
    let calls = 0;
    const result = await scan({
      defenseSkills: [],
      attacks: [],
      content: "hello",
      llmCall: async () => {
        calls += 1;
        return "benign 0.95";
      },
    });
    expect(result.tier).toBe(0);
    expect(calls).toBe(0);
    expect(result.total_tokens).toBe(0);
  });

  it("reports zero tokens when the LLM call fails (fallback path)", async () => {
    const ab = makeDefenseSkill("down", "Down", "readme", "You are a detector.", 1);
    const result = await scan({
      defenseSkills: [ab],
      attacks: [],
      content: "hello",
      llmCall: async () => {
        throw new Error("llm down");
      },
    });
    expect(result.tier).toBe(1);
    expect(result.total_tokens).toBe(0);
  });

  it("merged mode makes one LLM call and bypasses the escalation gate", async () => {
    const ab = makeDefenseSkill("a", "A", "readme", "You are a detector.", 1);
    let calls = 0;
    const result = await scan({
      defenseSkills: [ab],
      attacks: [],
      content: "hello",
      tier1Mode: "merged",
      escalationPolicy: "aggressive",
      sourceTrust: "high",
      llmCall: async (_system, _user, onCost) => {
        calls += 1;
        onCost?.(0.0005);
        return "malicious 0.8";
      },
    });
    expect(calls).toBe(1);
    expect(result.tier).toBe(1);
    expect(result.verdict).toBe("malicious");
    expect(result.total_cost_usd).toBeCloseTo(0.0005, 6);
    expect(
      result.script_results.some((r) => r.defense_skill_id === "merged-tier1"),
    ).toBe(true);
  });

  it("merged-pair mode makes two calls and OR-aggregates the verdicts", async () => {
    const ab = makeDefenseSkill("a", "A", "readme", "You are a detector.", 1);
    const hard = makeDefenseSkill("hard", "Hard", "readme", "Harden.", 1);
    hard.config.role = "non_detector";
    let calls = 0;
    const result = await scan({
      defenseSkills: [ab, hard],
      attacks: [],
      content: "hello",
      tier1Mode: "merged-pair",
      escalationPolicy: "aggressive",
      sourceTrust: "high",
      llmCall: async (system) => {
        calls += 1;
        return system.includes("[hard]") ? "benign 0.1" : "malicious 0.8";
      },
    });
    expect(calls).toBe(2);
    expect(result.tier).toBe(1);
    expect(result.verdict).toBe("malicious");
    expect(
      result.script_results.filter((r) => r.defense_skill_id === "merged-tier1"),
    ).toHaveLength(2);
  });
});

describe("scan() Tier 1 escalation", () => {
  const FAST_IDS = [
    "classifier-injection",
    "classifier-jailbreak",
    "builtin-poisoning",
  ];
  const FULL_IDS = [
    ...FAST_IDS,
    "builtin-injection",
    "builtin-jailbreak",
    "context-aware",
    "instruction-hierarchy",
    "llm-judge",
    "semantic-similarity",
  ];

  function makeEnsemble(): DefenseSkillEntry[] {
    return FULL_IDS.map((id) =>
      makeDefenseSkill(id, id, "readme", "You are a detector.", 1),
    );
  }

  it("safe policy runs only the fast subset on a clean scan", async () => {
    const called: string[] = [];
    const result = await scan({
      defenseSkills: makeEnsemble(),
      attacks: [],
      content: "hello",
      llmCall: async (system) => {
        const id = system.match(/\(([^)]+)\)/)![1];
        called.push(id);
        return "benign 0.1";
      },
      escalationPolicy: "safe",
      fastDetectorIds: FAST_IDS,
    });
    expect(called.sort()).toEqual([...FAST_IDS].sort());
    expect(result.verdict).toBe("benign");
    expect(result.script_results.some((r) => r.reason?.includes("fast subset clean"))).toBe(true);
  });

  it("weak Tier 0 signals escalate to the full ensemble", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-weak-"));
    const scriptPath = path.join(tmp, "weak.mjs");
    fs.writeFileSync(
      scriptPath,
      'console.log(JSON.stringify({ verdict: "suspicious", confidence: 0.5, reason: "weak" }));',
    );
    const weakAb = makeDefenseSkill("weak", "Weak", "readme", "", 0);
    weakAb.scriptPath = scriptPath;

    const called: string[] = [];
    const result = await scan({
      defenseSkills: [...makeEnsemble(), weakAb],
      attacks: [],
      content: "hello",
      llmCall: async (system) => {
        const id = system.match(/\(([^)]+)\)/)![1];
        called.push(id);
        return "benign 0.1";
      },
      escalationPolicy: "safe",
      fastDetectorIds: FAST_IDS,
    });
    expect(called.sort()).toEqual([...FULL_IDS].sort());
    expect(result.verdict).toBe("benign");
    expect(
      result.script_results.some(
        (r) => r.defense_skill_id === "escalation" && r.reason?.includes("full"),
      ),
    ).toBe(true);
  });

  it("aggressive policy skips the LLM on trusted clean input", async () => {
    let calls = 0;
    const result = await scan({
      defenseSkills: makeEnsemble(),
      attacks: [],
      content: "hello",
      llmCall: async () => {
        calls += 1;
        return "benign 0.1";
      },
      escalationPolicy: "aggressive",
      fastDetectorIds: FAST_IDS,
      sourceTrust: "high",
    });
    expect(calls).toBe(0);
    expect(result.tier).toBe(0);
    expect(result.verdict).toBe("benign");
  });

  it("aggressive policy still runs the fast subset on untrusted input", async () => {
    const called: string[] = [];
    const result = await scan({
      defenseSkills: makeEnsemble(),
      attacks: [],
      content: "hello",
      llmCall: async (system) => {
        const id = system.match(/\(([^)]+)\)/)![1];
        called.push(id);
        return "benign 0.1";
      },
      escalationPolicy: "aggressive",
      fastDetectorIds: FAST_IDS,
      sourceTrust: "low",
    });
    expect(called.sort()).toEqual([...FAST_IDS].sort());
    expect(result.verdict).toBe("benign");
  });

  it("fast subset that fires malicious blocks without running the rest", async () => {
    const called: string[] = [];
    const result = await scan({
      defenseSkills: makeEnsemble(),
      attacks: [],
      content: "hello",
      llmCall: async (system) => {
        const id = system.match(/\(([^)]+)\)/)![1];
        called.push(id);
        return id === "classifier-injection" ? "malicious 0.95" : "benign 0.1";
      },
      escalationPolicy: "safe",
      fastDetectorIds: FAST_IDS,
    });
    expect(called.length).toBe(3);
    expect(result.verdict).toBe("malicious");
  });

  it("suspicious fast subset escalates to the remaining detectors", async () => {
    const called: string[] = [];
    const result = await scan({
      defenseSkills: makeEnsemble(),
      attacks: [],
      content: "hello",
      llmCall: async (system) => {
        const id = system.match(/\(([^)]+)\)/)![1];
        called.push(id);
        return FAST_IDS.includes(id) ? "suspicious 0.55" : "benign 0.1";
      },
      escalationPolicy: "safe",
      fastDetectorIds: FAST_IDS,
    });
    expect(called.sort()).toEqual([...FULL_IDS].sort());
    expect(result.verdict).toBe("suspicious");
  });

  it("ensemble mode runs every detector and bypasses the escalation gate", async () => {
    const called: string[] = [];
    const result = await scan({
      defenseSkills: makeEnsemble(),
      attacks: [],
      content: "hello",
      tier1Mode: "ensemble",
      escalationPolicy: "aggressive",
      sourceTrust: "high",
      fastDetectorIds: FAST_IDS,
      llmCall: async (system) => {
        const id = system.match(/\(([^)]+)\)/)![1];
        called.push(id);
        return "benign 0.1";
      },
    });
    expect(called.sort()).toEqual([...FULL_IDS].sort());
    expect(result.verdict).toBe("benign");
    expect(
      result.script_results.some((r) => r.reason?.includes("no escalation gate")),
    ).toBe(true);
  });
});

describe("parseScanMode", () => {
  it("maps ablation HTTP modes onto scanner flags", () => {
    expect(parseScanMode("t0-only")).toEqual({ skipTier1: true });
    expect(parseScanMode("none")).toEqual({
      skipTier0: true,
      tier1Mode: "merged-pair",
    });
    expect(parseScanMode("ensemble")).toEqual({ tier1Mode: "ensemble" });
    expect(parseScanMode("merged")).toEqual({ tier1Mode: "merged" });
    expect(parseScanMode("merged-detectors")).toEqual({
      tier1Mode: "merged",
      mergedScope: "detectors",
    });
    expect(parseScanMode("merged-pair")).toEqual({ tier1Mode: "merged-pair" });
    expect(parseScanMode("full")).toEqual({});
  });
});

describe("scan() System I ablation modes", () => {
  function makeTier0Hit(): DefenseSkillEntry {
    const ab = makeDefenseSkill("t0", "T0", "readme", "", 0);
    ab.config.signatures = [
      { pattern: "evil-payload", type: "exact", label: "hit" },
    ];
    return ab;
  }

  it("t0-only returns the Tier 0 verdict without calling the LLM", async () => {
    let calls = 0;
    const result = await scan({
      defenseSkills: [makeTier0Hit()],
      attacks: [],
      content: "evil-payload in a file",
      skipTier1: true,
      llmCall: async () => {
        calls += 1;
        return "benign 0.1";
      },
    });
    expect(calls).toBe(0);
    expect(result.tier).toBe(0);
    expect(result.verdict).toBe("malicious");
  });

  it("none (skip Tier 0) still runs Tier 1 on a payload Tier 0 would block", async () => {
    let calls = 0;
    const t1 = makeDefenseSkill("t1", "T1", "readme", "You are a detector.", 1);
    const result = await scan({
      defenseSkills: [makeTier0Hit(), t1],
      attacks: [],
      content: "evil-payload in a file",
      skipTier0: true,
      tier1Mode: "merged-pair",
      llmCall: async () => {
        calls += 1;
        return "benign 0.1";
      },
    });
    expect(calls).toBe(2);
    expect(result.tier).toBe(1);
    expect(result.verdict).toBe("benign");
  });
});
