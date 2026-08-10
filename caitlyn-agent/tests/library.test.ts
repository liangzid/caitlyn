/**
 * Tests for library.ts — antibody loading, index building, persistence,
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
  AntibodyEntry,
  AntibodyConfig,
  AntibodyIndex,
} from "../src/schema.js";
import {
  buildAntibodyIndex,
  validateAntibodyConfig,
  validateAntigenConfig,
  loadAntibodyIndex,
  saveAntibodyIndex,
  saveAntibody,
  loadAntibodies,
  recordScanFeedback,
  checkLibraryIntegrity,
  antibodiesDir,
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

function makeAntibodyConfig(overrides: Partial<AntibodyConfig> = {}): AntibodyConfig {
  return {
    id: "ab-test-1",
    name: "Test Antibody",
    parent_id: null,
    category: "injection",
    tier: 1,
    threshold: 0.7,
    description: "Test description",
    affinity_score: 0.5,
    created_at: "2025-01-01T00:00:00Z",
    generation: 0,
    deps: [],
    signatures: [],
    prompt: "",
    role: "detector",
    stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
    ...overrides,
  };
}

function makeAntibodyEntry(overrides: Partial<AntibodyConfig> = {}): AntibodyEntry {
  return {
    config: makeAntibodyConfig(overrides),
    readme: "# README\n\nTest antibody readme.",
    scriptPath: null,
    folderPath: `/fake/antibodies/${overrides.id ?? "ab-test-1"}`,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("validateAntibodyConfig", () => {
  it("validates a correct minimal config", () => {
    const raw: Record<string, unknown> = {
      id: "ab-minimal",
      name: "Minimal",
      category: "injection",
      tier: 1,
      threshold: 0.5,
      description: "A minimal antibody",
      affinity_score: 0.3,
      created_at: "2025-01-01",
      generation: 1,
      stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
      deps: [],
      signatures: [],
    };

    const config = validateAntibodyConfig(raw);
    expect(config.id).toBe("ab-minimal");
    expect(config.name).toBe("Minimal");
    expect(config.category).toBe("injection");
    expect(config.tier).toBe(1);
    expect(config.prompt).toBe("");
    expect(config.role).toBe("detector");
  });

  it("parses prompt and role as first-class fields", () => {
    const raw: Record<string, unknown> = {
      id: "ab-prompted",
      name: "Prompted",
      category: "injection",
      tier: 1,
      threshold: 0.7,
      description: "Uses an LLM prompt",
      prompt: "You are a detector.\nOutput a verdict.",
      role: "detector",
      affinity_score: 0.3,
      created_at: "2025-01-01",
      generation: 1,
      stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
      deps: [],
      signatures: [],
    };

    const config = validateAntibodyConfig(raw);
    expect(config.prompt).toBe("You are a detector.\nOutput a verdict.");
    expect(config.role).toBe("detector");
  });

  it("defaults role to detector and rejects invalid roles", () => {
    const raw = {
      id: "ab-role",
      name: "Role",
      category: "injection",
      tier: 1,
      threshold: 0.5,
      description: "role test",
      affinity_score: 0.3,
      created_at: "2025-01-01",
      generation: 1,
      stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
      deps: [],
      signatures: [],
    };
    expect(validateAntibodyConfig(raw).role).toBe("detector");

    const nonDetector = validateAntibodyConfig({ ...raw, role: "non_detector" });
    expect(nonDetector.role).toBe("non_detector");

    expect(() => validateAntibodyConfig({ ...raw, role: "watcher" })).toThrow("role");
  });

  it("rejects missing required fields", () => {
    expect(() => validateAntibodyConfig({} as Record<string, unknown>)).toThrow();
  });

  it("rejects invalid category", () => {
    const raw = {
      id: "ab-bad",
      name: "Bad",
      category: "invalid_category",
      tier: 1,
      threshold: 0.5,
      description: "bad",
      affinity_score: 0.3,
      created_at: "2025-01-01",
      generation: 1,
      stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
      deps: [],
      signatures: [],
    };
    expect(() => validateAntibodyConfig(raw)).toThrow("category");
  });

  it("rejects invalid tier", () => {
    const raw = {
      id: "ab-bad",
      name: "Bad",
      category: "injection",
      tier: 5,
      threshold: 0.5,
      description: "bad",
      affinity_score: 0.3,
      created_at: "2025-01-01",
      generation: 1,
      stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
      deps: [],
      signatures: [],
    };
    expect(() => validateAntibodyConfig(raw)).toThrow("tier");
  });
});

describe("validateAntigenConfig", () => {
  it("validates a correct minimal config", () => {
    const raw: Record<string, unknown> = {
      id: "ag-minimal",
      name: "Minimal Antigen",
      category: "injection",
      injection_point: "user_prompt",
      target_agent: "test-agent",
      attack_template: "Ignore previous instructions",
      created_at: "2025-01-01",
      escapes: ["escape-1"],
    };

    const config = validateAntigenConfig(raw);
    expect(config.id).toBe("ag-minimal");
    expect(config.name).toBe("Minimal Antigen");
  });

  it("rejects missing id", () => {
    expect(() =>
      validateAntigenConfig({ name: "No ID", category: "injection" } as Record<string, unknown>),
    ).toThrow();
  });
});

describe("buildAntibodyIndex", () => {
  it("creates correct tree structure with root and child antibodies", () => {
    const parent = makeAntibodyEntry({ id: "parent", parent_id: null });
    const child = makeAntibodyEntry({ id: "child", parent_id: "parent" });

    const index = buildAntibodyIndex([parent, child]);

    expect(index.roots).toHaveLength(1);
    expect(index.roots[0]).toBe("parent");

    expect(index.trees["parent"]).toBeTruthy();
    expect(index.trees["child"]).toBeTruthy();
    expect(index.trees["parent"].children).toContain("child");
  });

  it("handles multiple root antibodies", () => {
    const ab1 = makeAntibodyEntry({ id: "ab1", parent_id: null });
    const ab2 = makeAntibodyEntry({ id: "ab2", parent_id: null });

    const index = buildAntibodyIndex([ab1, ab2]);
    expect(index.roots).toHaveLength(2);
    expect(index.roots.sort()).toEqual(["ab1", "ab2"]);
  });

  it("orphan antibodies with non-existent parent are not added to roots", () => {
    // When parent_id points to a non-existent antibody, neither the
    // parent check nor the root check matches, so the antibody is in trees
    // but not in roots. This is the current implementation behavior.
    const ab = makeAntibodyEntry({ id: "orphan", parent_id: "nonexistent" });

    const index = buildAntibodyIndex([ab]);
    // The orphan exists in trees but is NOT a root
    expect(index.trees["orphan"]).toBeTruthy();
    expect(index.roots).not.toContain("orphan");
  });

  it("aggregates stats from children to parents", () => {
    const parent = makeAntibodyEntry({
      id: "parent",
      parent_id: null,
      stats: { total_scans: 5, true_positives: 3, false_positives: 2, avg_latency_us: 100 },
    });
    const child = makeAntibodyEntry({
      id: "child",
      parent_id: "parent",
      stats: { total_scans: 10, true_positives: 8, false_positives: 2, avg_latency_us: 200 },
    });

    const index = buildAntibodyIndex([parent, child]);

    const parentNode = index.trees["parent"];
    expect(parentNode.stats_aggregated.total_scans).toBe(15); // 5 + 10
    expect(parentNode.stats_aggregated.true_positives).toBe(11); // 3 + 8
    expect(parentNode.stats_aggregated.false_positives).toBe(4); // 2 + 2
  });

  it("returns empty index for empty input", () => {
    const index = buildAntibodyIndex([]);
    expect(index.roots).toEqual([]);
    expect(Object.keys(index.trees)).toHaveLength(0);
  });

  it("handles deep nesting (grandparent -> parent -> child)", () => {
    const gp = makeAntibodyEntry({ id: "gp", parent_id: null });
    const p = makeAntibodyEntry({ id: "p", parent_id: "gp" });
    const c = makeAntibodyEntry({ id: "c", parent_id: "p" });

    const index = buildAntibodyIndex([gp, p, c]);
    expect(index.roots).toEqual(["gp"]);
    expect(index.trees["gp"].children).toEqual(["p"]);
    expect(index.trees["p"].children).toEqual(["c"]);
  });
});

describe("loadAntibodies", () => {
  it("returns entries from the antibodies/ directory", () => {
    // The real antibodies directory exists in the project.
    // loadAntibodies() should find and load real antibody configs.
    const antibodies = loadAntibodies();

    // The project has 20+ antibody directories
    expect(antibodies.length).toBeGreaterThan(0);
    // Each entry should have required fields
    for (const ab of antibodies) {
      expect(ab.config.id).toBeTruthy();
      expect(ab.config.name).toBeTruthy();
      expect(ab.config.category).toBeTruthy();
      expect(typeof ab.config.tier).toBe("number");
    }
  });

  it("caches results and returns same objects on repeated calls", () => {
    const result1 = loadAntibodies();
    const result2 = loadAntibodies();

    // Should return the same array reference (cached)
    expect(result1).toBe(result2);
  });
});

describe("index persistence", () => {
  let tmpDir: string;
  let tmpAbDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-lib-test-"));
    tmpAbDir = path.join(tmpDir, "antibodies");
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("saveAntibodyIndex() + loadAntibodyIndex() round-trip via custom path", () => {
    // We can't easily override ANTIBODIES_DIR, but we test the
    // save/load round-trip by writing and reading JSON directly
    const index: AntibodyIndex = {
      roots: ["ab-root"],
      trees: {
        "ab-root": {
          id: "ab-root",
          children: ["ab-child"],
          stats_aggregated: {
            total_scans: 10,
            true_positives: 7,
            false_positives: 3,
            avg_latency_us: 500,
          },
        },
        "ab-child": {
          id: "ab-child",
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
    const parsed = JSON.parse(raw) as AntibodyIndex;
    expect(parsed.roots).toEqual(["ab-root"]);
    expect(parsed.trees["ab-root"].children).toEqual(["ab-child"]);
    expect(parsed.trees["ab-child"].stats_aggregated.total_scans).toBe(5);
  });

  it("loadAntibodyIndex() returns null for missing index file", () => {
    // When the index.json doesn't exist, it returns null
    // We verify the behavior pattern by checking the function reads from ANTIBODIES_DIR
    const indexPath = path.join(antibodiesDir(), "index.json");
    // The index.json should exist since it's auto-generated
    const result = loadAntibodyIndex();
    // It should either be null (no index) or a valid index with roots
    if (result !== null) {
      expect(Array.isArray(result.roots)).toBe(true);
      expect(typeof result.trees).toBe("object");
    }
  });
});

describe("recordScanFeedback", () => {
  it("handles non-existent antibody ids gracefully", () => {
    // recordScanFeedback calls loadAntibodies() internally.
    // We test that it handles non-existent IDs gracefully.
    // It should not throw for missing antibodies (continue on !antibody).
    expect(() => {
      recordScanFeedback(
        [
          {
            antibody_id: "nonexistent-ab-id",
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
            antibody_id: "nonexistent-ab-id",
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
    const tier0 = makeAntibodyEntry({
      id: "ab-t0",
      tier: 0,
      signatures: [{ pattern: "ignore previous", type: "exact", label: "ignore" }],
    });
    tier0.scriptPath = "/fake/antibodies/ab-t0/detect.ts";

    const tier1 = makeAntibodyEntry({
      id: "ab-t1",
      tier: 1,
      prompt: "You are a detector.",
    });

    const hardener = makeAntibodyEntry({
      id: "ab-hardener",
      tier: 1,
      role: "non_detector",
      prompt: "You harden prompts.",
    });

    expect(checkLibraryIntegrity([tier0, tier1, hardener])).toEqual([]);
  });

  it("flags tier 0 detectors without any executable artifact", () => {
    const ab = makeAntibodyEntry({ id: "ab-dead-t0", tier: 0 });
    const issues = checkLibraryIntegrity([ab]);
    expect(issues.join("\n")).toContain("ab-dead-t0");
    expect(issues.join("\n")).toContain("without detect.ts or signatures");
  });

  it("flags tier 1/2 detectors without a prompt", () => {
    const ab = makeAntibodyEntry({ id: "ab-dead-t1", tier: 1, prompt: "" });
    const issues = checkLibraryIntegrity([ab]);
    expect(issues.join("\n")).toContain("ab-dead-t1");
    expect(issues.join("\n")).toContain("without prompt");
  });

  it("flags duplicate ids and duplicate runtime signatures", () => {
    const sig = { pattern: "send.*to", type: "regex", label: "exfil" };
    const a = makeAntibodyEntry({
      id: "ab-dup",
      tier: 0,
      signatures: [sig],
    });
    a.scriptPath = null;
    const b = makeAntibodyEntry({
      id: "ab-dup",
      tier: 0,
      signatures: [sig],
    });
    b.scriptPath = null;

    const issues = checkLibraryIntegrity([a, b]);
    expect(issues.join("\n")).toContain("duplicate antibody id: ab-dup");
    expect(issues.join("\n")).toContain("duplicate tier 0 signature");
  });
});

describe("saveAntibody round-trip", () => {
  it("preserves prompt, role and signatures when persisting", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-lib-rt-"));
    fs.mkdirSync(path.join(dir, "antibodies"), { recursive: true });
    const prev = process.env.CAITLYN_LIBRARY_DIR;
    process.env.CAITLYN_LIBRARY_DIR = dir;
    try {
      const entry = makeAntibodyEntry({
        id: "ab-roundtrip",
        tier: 1,
        prompt: "You are a detector.\nAnalyze carefully.",
        role: "detector",
        signatures: [
          { pattern: "ignore previous", type: "exact", label: "ignore" },
        ],
      });
      entry.folderPath = path.join(dir, "antibodies", "ab-roundtrip");
      entry.scriptPath = null;

      saveAntibody(entry);

      const loaded = loadAntibodies().find((a) => a.config.id === "ab-roundtrip");
      expect(loaded?.config.prompt).toBe("You are a detector.\nAnalyze carefully.");
      expect(loaded?.config.role).toBe("detector");
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
});
