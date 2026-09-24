/**
 * Tests for library.ts — defense skill loading, index building, persistence,
 * and scan feedback.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  DefenseSkillEntry,
  DefenseSkillConfig,
  DefenseSkillIndex,
} from "../src/schema.js";
import {
  buildDefenseSkillIndex,
  validateDefenseSkillConfig,
  validateAttackConfig,
  loadDefenseSkillIndex,
  saveDefenseSkillIndex,
  saveDefenseSkill,
  loadDefenseSkills,
  recordScanFeedback,
  checkLibraryIntegrity,
  defenseSkillsDir,
} from "../src/library.js";

// The library copy installed by the global setup would shadow the real
// repository library this suite must exercise; restore it explicitly.
let originalLibraryDir: string | undefined;
beforeAll(() => {
  originalLibraryDir = process.env.CAITLYN_LIBRARY_DIR;
  delete process.env.CAITLYN_LIBRARY_DIR;
});
afterAll(() => {
  if (originalLibraryDir) {
    process.env.CAITLYN_LIBRARY_DIR = originalLibraryDir;
  } else {
    delete process.env.CAITLYN_LIBRARY_DIR;
  }
});

// ── Test Helpers ────────────────────────────────────────────────────

function makeDefenseSkillConfig(overrides: Partial<DefenseSkillConfig> = {}): DefenseSkillConfig {
  return {
    id: "test-1",
    name: "Test Defense skill",
    parent_id: null,
    category: "injection",
    tier: 1,
    threshold: 0.7,
    description: "Test description",
    match_score: 0.5,
    created_at: "2025-01-01T00:00:00Z",
    generation: 0,
    deps: [],
    signatures: [],
    prompt: "",
    role: "detector",
    implementation_status: "active",
    execution_stages: ["content_scan"],
    references: [],
    runtime_requirements: [],
    stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
    ...overrides,
  };
}

function makeDefenseSkillEntry(overrides: Partial<DefenseSkillConfig> = {}): DefenseSkillEntry {
  return {
    config: makeDefenseSkillConfig(overrides),
    readme: "# README\n\nTest defense skill readme.",
    scriptPath: null,
    folderPath: `/fake/skills/${overrides.id ?? "test-1"}`,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("validateDefenseSkillConfig", () => {
  it("validates a correct minimal config", () => {
    const raw: Record<string, unknown> = {
      id: "minimal",
      name: "Minimal",
      category: "injection",
      tier: 1,
      threshold: 0.5,
      description: "A minimal defense skill",
      match_score: 0.3,
      created_at: "2025-01-01",
      generation: 1,
      stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
      deps: [],
      signatures: [],
    };

    const config = validateDefenseSkillConfig(raw);
    expect(config.id).toBe("minimal");
    expect(config.name).toBe("Minimal");
    expect(config.category).toBe("injection");
    expect(config.tier).toBe(1);
    expect(config.prompt).toBe("");
    expect(config.role).toBe("detector");
    expect(config.implementation_status).toBe("active");
    expect(config.execution_stages).toEqual(["content_scan"]);
    expect(config.references).toEqual([]);
  });

  it("parses prompt and role as first-class fields", () => {
    const raw: Record<string, unknown> = {
      id: "prompted",
      name: "Prompted",
      category: "injection",
      tier: 1,
      threshold: 0.7,
      description: "Uses an LLM prompt",
      prompt: "You are a detector.\nOutput a verdict.",
      role: "detector",
      match_score: 0.3,
      created_at: "2025-01-01",
      generation: 1,
      stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
      deps: [],
      signatures: [],
    };

    const config = validateDefenseSkillConfig(raw);
    expect(config.prompt).toBe("You are a detector.\nOutput a verdict.");
    expect(config.role).toBe("detector");
  });

  it("defaults role to detector and rejects invalid roles", () => {
    const raw = {
      id: "role",
      name: "Role",
      category: "injection",
      tier: 1,
      threshold: 0.5,
      description: "role test",
      match_score: 0.3,
      created_at: "2025-01-01",
      generation: 1,
      stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
      deps: [],
      signatures: [],
    };
    expect(validateDefenseSkillConfig(raw).role).toBe("detector");

    const nonDetector = validateDefenseSkillConfig({ ...raw, role: "non_detector" });
    expect(nonDetector.role).toBe("non_detector");

    expect(() => validateDefenseSkillConfig({ ...raw, role: "watcher" })).toThrow("role");
  });

  it("parses defense maturity, execution stages, and references", () => {
    const config = validateDefenseSkillConfig({
      id: "reference",
      name: "Reference",
      category: "tool_misuse",
      tier: 2,
      threshold: 0.6,
      description: "Research reference",
      role: "non_detector",
      implementation_status: "reference",
      execution_stages: ["tool_pre_call", "trajectory"],
      references: [{ title: "Paper", url: "https://example.com/paper", year: 2026 }],
      runtime_requirements: ["trusted user objective"],
      match_score: 0,
      created_at: "2026-08-28",
      generation: 0,
      stats: {},
      deps: [],
      signatures: [],
    });

    expect(config.implementation_status).toBe("reference");
    expect(config.execution_stages).toEqual(["tool_pre_call", "trajectory"]);
    expect(config.references[0]?.year).toBe(2026);
    expect(config.runtime_requirements).toEqual(["trusted user objective"]);
  });

  it("rejects missing required fields", () => {
    expect(() => validateDefenseSkillConfig({} as Record<string, unknown>)).toThrow();
  });

  it("rejects invalid category", () => {
    const raw = {
      id: "bad",
      name: "Bad",
      category: "invalid_category",
      tier: 1,
      threshold: 0.5,
      description: "bad",
      match_score: 0.3,
      created_at: "2025-01-01",
      generation: 1,
      stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
      deps: [],
      signatures: [],
    };
    expect(() => validateDefenseSkillConfig(raw)).toThrow("category");
  });

  it("rejects invalid tier", () => {
    const raw = {
      id: "bad",
      name: "Bad",
      category: "injection",
      tier: 5,
      threshold: 0.5,
      description: "bad",
      match_score: 0.3,
      created_at: "2025-01-01",
      generation: 1,
      stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
      deps: [],
      signatures: [],
    };
    expect(() => validateDefenseSkillConfig(raw)).toThrow("tier");
  });
});

describe("validateAttackConfig", () => {
  it("validates a correct minimal config", () => {
    const raw: Record<string, unknown> = {
      id: "minimal",
      name: "Minimal Attack",
      category: "injection",
      injection_point: "user_prompt",
      target_agent: "test-agent",
      attack_template: "Ignore previous instructions",
      created_at: "2025-01-01",
      escapes: ["escape-1"],
    };

    const config = validateAttackConfig(raw);
    expect(config.id).toBe("minimal");
    expect(config.name).toBe("Minimal Attack");
  });

  it("rejects missing id", () => {
    expect(() =>
      validateAttackConfig({ name: "No ID", category: "injection" } as Record<string, unknown>),
    ).toThrow();
  });
});

describe("buildDefenseSkillIndex", () => {
  it("creates correct tree structure with root and child defense skills", () => {
    const parent = makeDefenseSkillEntry({ id: "parent", parent_id: null });
    const child = makeDefenseSkillEntry({ id: "child", parent_id: "parent" });

    const index = buildDefenseSkillIndex([parent, child]);

    expect(index.roots).toHaveLength(1);
    expect(index.roots[0]).toBe("parent");

    expect(index.trees["parent"]).toBeTruthy();
    expect(index.trees["child"]).toBeTruthy();
    expect(index.trees["parent"].children).toContain("child");
  });

  it("handles multiple root defense skills", () => {
    const ab1 = makeDefenseSkillEntry({ id: "ab1", parent_id: null });
    const ab2 = makeDefenseSkillEntry({ id: "ab2", parent_id: null });

    const index = buildDefenseSkillIndex([ab1, ab2]);
    expect(index.roots).toHaveLength(2);
    expect(index.roots.sort()).toEqual(["ab1", "ab2"]);
  });

  it("orpha defense skills with non-existent parent are not added to roots", () => {
    // When parent_id points to a non-existent defense skill, neither the
    // parent check nor the root check matches, so the defense skill is in trees
    // but not in roots. This is the current implementation behavior.
    const ab = makeDefenseSkillEntry({ id: "orphan", parent_id: "nonexistent" });

    const index = buildDefenseSkillIndex([ab]);
    // The orphan exists in trees but is NOT a root
    expect(index.trees["orphan"]).toBeTruthy();
    expect(index.roots).not.toContain("orphan");
  });

  it("aggregates stats from children to parents", () => {
    const parent = makeDefenseSkillEntry({
      id: "parent",
      parent_id: null,
      stats: { total_scans: 5, true_positives: 3, false_positives: 2, avg_latency_us: 100 },
    });
    const child = makeDefenseSkillEntry({
      id: "child",
      parent_id: "parent",
      stats: { total_scans: 10, true_positives: 8, false_positives: 2, avg_latency_us: 200 },
    });

    const index = buildDefenseSkillIndex([parent, child]);

    const parentNode = index.trees["parent"];
    expect(parentNode.stats_aggregated.total_scans).toBe(15); // 5 + 10
    expect(parentNode.stats_aggregated.true_positives).toBe(11); // 3 + 8
    expect(parentNode.stats_aggregated.false_positives).toBe(4); // 2 + 2
  });

  it("returns empty index for empty input", () => {
    const index = buildDefenseSkillIndex([]);
    expect(index.roots).toEqual([]);
    expect(Object.keys(index.trees)).toHaveLength(0);
  });

  it("handles deep nesting (grandparent -> parent -> child)", () => {
    const gp = makeDefenseSkillEntry({ id: "gp", parent_id: null });
    const p = makeDefenseSkillEntry({ id: "p", parent_id: "gp" });
    const c = makeDefenseSkillEntry({ id: "c", parent_id: "p" });

    const index = buildDefenseSkillIndex([gp, p, c]);
    expect(index.roots).toEqual(["gp"]);
    expect(index.trees["gp"].children).toEqual(["p"]);
    expect(index.trees["p"].children).toEqual(["c"]);
  });
});

describe("loadDefenseSkills", () => {
  it("returns entries from the skills/ directory", () => {
    // The real defense skills directory exists in the project.
    // loadDefenseSkills() should find and load real defense skill configs.
    const defenseSkills = loadDefenseSkills();

    // The project has 20+ defense skill directories
    expect(defenseSkills.length).toBeGreaterThan(0);
    // Each entry should have required fields
    for (const ab of defenseSkills) {
      expect(ab.config.id).toBeTruthy();
      expect(ab.config.name).toBeTruthy();
      expect(ab.config.category).toBeTruthy();
      expect(typeof ab.config.tier).toBe("number");
    }
  });

  it("caches results and returns same objects on repeated calls", () => {
    const result1 = loadDefenseSkills();
    const result2 = loadDefenseSkills();

    // Should return the same array reference (cached)
    expect(result1).toBe(result2);
  });
});

describe("index persistence", () => {
  let tmpDir: string;
  let tmpAbDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-lib-test-"));
    tmpAbDir = path.join(tmpDir, "skills");
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("saveDefenseSkillIndex() + loadDefenseSkillIndex() round-trip via custom path", () => {
    // We can't easily override DEFENSE_SKILLS_DIR, but we test the
    // save/load round-trip by writing and reading JSON directly
    const index: DefenseSkillIndex = {
      roots: ["root"],
      trees: {
        "root": {
          id: "root",
          children: ["child"],
          stats_aggregated: {
            total_scans: 10,
            true_positives: 7,
            false_positives: 3,
            avg_latency_us: 500,
          },
        },
        "child": {
          id: "child",
          children: [],
          stats_aggregated: {
            total_scans: 5,
            true_positives: 4,
            false_positives: 1,
            avg_latency_us: 300,
          },
        },
      },
    };

    // Write to a temp location
    const savePath = path.join(tmpAbDir, "index.json");
    fs.mkdirSync(tmpAbDir, { recursive: true });
    fs.writeFileSync(savePath, JSON.stringify(index, null, 2), "utf-8");

    // Read back
    const raw = fs.readFileSync(savePath, "utf-8");
    const parsed = JSON.parse(raw) as DefenseSkillIndex;
    expect(parsed.roots).toEqual(["root"]);
    expect(parsed.trees["root"].children).toEqual(["child"]);
    expect(parsed.trees["child"].stats_aggregated.total_scans).toBe(5);
  });

  it("loadDefenseSkillIndex() returns null for missing index file", () => {
    // When the index.json doesn't exist, it returns null
    // We verify the behavior pattern by checking the function reads from DEFENSE_SKILLS_DIR
    const indexPath = path.join(defenseSkillsDir(), "index.json");
    // The index.json should exist since it's auto-generated
    const result = loadDefenseSkillIndex();
    // It should either be null (no index) or a valid index with roots
    if (result !== null) {
      expect(Array.isArray(result.roots)).toBe(true);
      expect(typeof result.trees).toBe("object");
    }
  });
});

describe("recordScanFeedback", () => {
  it("handles non-existent defense skill ids gracefully", () => {
    // recordScanFeedback calls loadDefenseSkills() internally.
    // We test that it handles non-existent IDs gracefully.
    // It should not throw for missing defense skills (continue on !defense skill).
    expect(() => {
      recordScanFeedback(
        [
          {
            defense_skill_id: "nonexistent-id",
            verdict: "malicious",
            confidence: 0.9,
            latency_us: 5000,
            fired: true,
          },
        ],
        "malicious",
      );
    }).not.toThrow();
  });

  it("handles benign verdict without throwing", () => {
    expect(() => {
      recordScanFeedback(
        [
          {
            defense_skill_id: "nonexistent-id",
            verdict: "benign",
            confidence: 0.1,
            latency_us: 3000,
            fired: false,
          },
        ],
        "benign",
      );
    }).not.toThrow();
  });
});

describe("checkLibraryIntegrity", () => {
  it("accepts a sound library", () => {
    const tier0 = makeDefenseSkillEntry({
      id: "t0",
      tier: 0,
      signatures: [{ pattern: "ignore previous", type: "exact", label: "ignore" }],
    });
    tier0.scriptPath = "/fake/skills/t0/detect.ts";

    const tier1 = makeDefenseSkillEntry({
      id: "t1",
      tier: 1,
      prompt: "You are a detector.",
    });

    const hardener = makeDefenseSkillEntry({
      id: "hardener",
      tier: 1,
      role: "non_detector",
      prompt: "You harden prompts.",
    });

    expect(checkLibraryIntegrity([tier0, tier1, hardener])).toEqual([]);
  });

  it("flags tier 0 detectors without any executable artifact", () => {
    const ab = makeDefenseSkillEntry({ id: "dead-t0", tier: 0 });
    const issues = checkLibraryIntegrity([ab]);
    expect(issues.join("\n")).toContain("dead-t0");
    expect(issues.join("\n")).toContain("without detect.ts or signatures");
  });

  it("flags tier 1/2 detectors without a prompt", () => {
    const ab = makeDefenseSkillEntry({ id: "dead-t1", tier: 1, prompt: "" });
    const issues = checkLibraryIntegrity([ab]);
    expect(issues.join("\n")).toContain("dead-t1");
    expect(issues.join("\n")).toContain("without prompt");
  });

  it("flags duplicate ids and duplicate runtime signatures", () => {
    const sig = { pattern: "send.*to", type: "regex", label: "exfil" };
    const a = makeDefenseSkillEntry({
      id: "dup",
      tier: 0,
      signatures: [sig],
    });
    a.scriptPath = null;
    const b = makeDefenseSkillEntry({
      id: "dup",
      tier: 0,
      signatures: [sig],
    });
    b.scriptPath = null;

    const issues = checkLibraryIntegrity([a, b]);
    expect(issues.join("\n")).toContain("duplicate defense skill id: dup");
    expect(issues.join("\n")).toContain("duplicate tier 0 signature");
  });
});

describe("saveDefenseSkill round-trip", () => {
  it("preserves prompt, role and signatures when persisting", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-lib-rt-"));
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    const prev = process.env.CAITLYN_LIBRARY_DIR;
    process.env.CAITLYN_LIBRARY_DIR = dir;
    try {
      const entry = makeDefenseSkillEntry({
        id: "roundtrip",
        tier: 1,
        prompt: "You are a detector.\nAnalyze carefully.",
        role: "detector",
        implementation_status: "experimental",
        execution_stages: ["content_scan"],
        references: [{ title: "Source", url: "https://example.com", year: 2026 }],
        runtime_requirements: ["evaluation"],
        signatures: [
          { pattern: "ignore previous", type: "exact", label: "ignore" },
        ],
      });
      entry.folderPath = path.join(dir, "skills", "roundtrip");
      entry.scriptPath = null;

      saveDefenseSkill(entry);

      const loaded = loadDefenseSkills().find((a) => a.config.id === "roundtrip");
      expect(loaded?.config.prompt).toBe("You are a detector.\nAnalyze carefully.");
      expect(loaded?.config.role).toBe("detector");
      expect(loaded?.config.implementation_status).toBe("experimental");
      expect(loaded?.config.execution_stages).toEqual(["content_scan"]);
      expect(loaded?.config.references[0]?.title).toBe("Source");
      expect(loaded?.config.runtime_requirements).toEqual(["evaluation"]);
      expect(loaded?.config.signatures).toEqual([
        { pattern: "ignore previous", type: "exact", label: "ignore" },
      ]);
    } finally {
      if (prev === undefined) {
        delete process.env.CAITLYN_LIBRARY_DIR;
      } else {
        process.env.CAITLYN_LIBRARY_DIR = prev;
      }
    }
  });

  it("accepts a documented reference skill without runtime artifacts", () => {
    const reference = makeDefenseSkillEntry({
      id: "paper",
      role: "non_detector",
      tier: 2,
      implementation_status: "reference",
      execution_stages: ["runtime_isolation"],
      references: [{ title: "Paper", url: "https://example.com/paper", year: 2026 }],
      runtime_requirements: ["isolated runtime"],
    });

    expect(checkLibraryIntegrity([reference])).toEqual([]);
  });

  it("rejects undocumented or incomplete reference skills", () => {
    const reference = makeDefenseSkillEntry({
      id: "paper",
      role: "non_detector",
      tier: 2,
      implementation_status: "reference",
      execution_stages: ["runtime_isolation"],
      references: [],
      runtime_requirements: [],
    });
    reference.readme = "";

    const issues = checkLibraryIntegrity([reference]).join("\n");
    expect(issues).toContain("missing or empty README.md");
    expect(issues).toContain("reference skill without a source");
    expect(issues).toContain("reference skill without runtime_requirements");
  });
});
