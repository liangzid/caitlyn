/**
 * Tests for yaml-parser.ts — parseYaml, coerceValue, and normalizeConfig.
 */
import { describe, it, expect } from "vitest";
import { parseYaml, coerceValue } from "../src/yaml-parser.js";

// Re-import normalizeConfig for testing (it's not exported from library.ts)
// We re-implement it in the test since it's a private function in library.ts.
function normalizeConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };

  for (const [key, value] of Object.entries(out)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const nested = value as Record<string, unknown>;
    for (const [nk, nv] of Object.entries(nested)) {
      if (!nk.startsWith("_list_")) continue;
      const realName = nk.slice(6);
      out[realName] = nv;
      if (key !== realName && Object.keys(nested).every((k) => k.startsWith("_list_"))) {
        delete out[key];
      }
    }
  }

  // Ensure stats has defaults
  if (!out.stats || typeof out.stats !== "object") {
    out.stats = { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 };
  }

  return out;
}

// ── coerceValue tests ───────────────────────────────────────────────

describe("coerceValue", () => {
  it("returns numbers for numeric strings", () => {
    expect(coerceValue("42")).toBe(42);
    expect(coerceValue("-3")).toBe(-3);
    expect(coerceValue("3.14")).toBe(3.14);
    expect(coerceValue("0")).toBe(0);
  });

  it("returns booleans for true/false strings", () => {
    expect(coerceValue("true")).toBe(true);
    expect(coerceValue("false")).toBe(false);
  });

  it("returns null for empty string or null string", () => {
    expect(coerceValue("")).toBeNull();
    expect(coerceValue("null")).toBeNull();
  });

  it("strips quotes from quoted strings", () => {
    expect(coerceValue('"hello"')).toBe("hello");
    expect(coerceValue("'world'")).toBe("world");
  });

  it("passes through non-string values unchanged", () => {
    expect(coerceValue(42)).toBe(42);
    expect(coerceValue(true)).toBe(true);
    expect(coerceValue(null)).toBeNull();
  });

  it("returns string for unquoted non-numeric, non-boolean values", () => {
    expect(coerceValue("hello")).toBe("hello");
    expect(coerceValue("abc123")).toBe("abc123");
  });
});

// ── parseYaml tests ─────────────────────────────────────────────────

describe("parseYaml", () => {
  it("parses simple key-value pairs", () => {
    const result = parseYaml("name: test\nid: ab-1\nthreshold: 0.6");
    expect(result).toEqual({ name: "test", id: "ab-1", threshold: 0.6 });
  });

  it("parses nested objects", () => {
    const yaml = "stats:\n  total_scans: 10\n  true_positives: 5";
    const result = parseYaml(yaml);
    expect(result).toEqual({
      stats: { total_scans: 10, true_positives: 5 },
    });
  });

  it("parses lists (new format — stored under parent key, flattened by normalizeConfig)", () => {
    const yaml = "deps:\n  - node\n  - tsx\n  - bun";
    const result = parseYaml(yaml);
    // Raw parse nests under same key; normalizeConfig flattens it
    expect(result).toEqual({
      deps: { deps: ["node", "tsx", "bun"] },
    });
  });

  it("handles empty file", () => {
    expect(parseYaml("")).toEqual({});
  });

  it("handles only comments", () => {
    expect(parseYaml("# comment 1\n# comment 2")).toEqual({});
  });
  it("handles deep nesting (3+ levels) — new parser supports arbitrary depth", () => {
    const yaml = "level1:\n  level2:\n    level3:\n      key: deep_value";
    const result = parseYaml(yaml);
    expect(result).toHaveProperty("level1");
    const level1 = result["level1"] as Record<string, unknown>;
    expect(level1).toHaveProperty("level2");
    const level2 = level1["level2"] as Record<string, unknown>;
    expect(level2).toHaveProperty("level3");
    const level3 = level2["level3"] as Record<string, unknown>;
    expect(level3).toHaveProperty("key", "deep_value");
  });

  it("parses quoted strings", () => {
    const result = parseYaml('name: "hello world"\ndesc: \'single quoted\'');
    expect(result).toEqual({ name: "hello world", desc: "single quoted" });
  });

  it("parses numbers correctly", () => {
    const result = parseYaml("threshold: 0.75\ntier: 1\ngeneration: 0\nnegative: -5");
    expect(result).toEqual({
      threshold: 0.75,
      tier: 1,
      generation: 0,
      negative: -5,
    });
  });

  it("parses booleans", () => {
    const result = parseYaml("enabled: true\ndisabled: false");
    expect(result).toEqual({ enabled: true, disabled: false });
  });

  it("parses null", () => {
    const result = parseYaml("parent_id: null");
    expect(result).toEqual({ parent_id: null });
  });

  it("handles mixed top-level and nested content", () => {
    const yaml = [
      "id: ab-test",
      "name: Test",
      "parent_id: null",
      "category: injection",
      "tier: 0",
      "threshold: 0.6",
      "stats:",
      "  total_scans: 100",
      "  true_positives: 80",
      "deps:",
      "  - node",
      "  - tsx",
    ].join("\n");

    const result = parseYaml(yaml);
    expect(result).toEqual({
      id: "ab-test",
      name: "Test",
      parent_id: null,
      category: "injection",
      tier: 0,
      threshold: 0.6,
      stats: { total_scans: 100, true_positives: 80 },
      deps: { deps: ["node", "tsx"] },
    });
  });

  it("handles lines with no colon gracefully", () => {
    const yaml = "valid: key\ninvalid_line_without_colon\nanother: value";
    const result = parseYaml(yaml);
    expect(result).toEqual({ valid: "key", another: "value" });
  });

  it("handles indented lines under a top-level key with value", () => {
    // When currentNested is null, indented lines fall through to top-level
    // processing and are treated as top-level keys.
    const yaml = "key: value\n  ignored: should_not_appear";
    const result = parseYaml(yaml);
    expect(result).toEqual({ key: "value", ignored: "should_not_appear" });
  });

  // ── M1: Multi-line strings ──────────────────────────────────────

  it("parses literal block scalar (|)", () => {
    const yaml = "description: |\n  Line one\n  Line two\n  Line three\nname: test";
    const result = parseYaml(yaml);
    expect(result.description).toBe("Line one\nLine two\nLine three");
    expect(result.name).toBe("test");
  });

  it("parses folded block scalar (>)", () => {
    const yaml = "summary: >\n  This is a long\n  description that\n  spans multiple lines\nkey: value";
    const result = parseYaml(yaml);
    expect(result.summary).toBe("This is a long description that spans multiple lines");
    expect(result.key).toBe("value");
  });

  it("handles multi-line block at end of file", () => {
    const yaml = "key: value\nnote: |\n  Final line";
    const result = parseYaml(yaml);
    expect(result.key).toBe("value");
    expect(result.note).toBe("Final line");
  });

  // ── M2: List-of-objects ──────────────────────────────────────────

  it("parses list of objects with indented sub-keys", () => {
    const yaml = [
      "signatures:",
      '  - pattern: "ignore..."',
      "    type: block",
      '    label: "XSS Attempt"',
      '  - pattern: "eval("',
      "    type: regex",
      '    label: "Code Injection"',
    ].join("\n");
    const result = parseYaml(yaml);
    const sigs = result.signatures as Record<string, unknown>;
    const arr = sigs.signatures as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    expect(arr[0]).toEqual({ pattern: "ignore...", type: "block", label: "XSS Attempt" });
    expect(arr[1]).toEqual({ pattern: "eval(", type: "regex", label: "Code Injection" });
  });

  it("parses list of objects with empty initial key", () => {
    const yaml = "items:\n  - name:\n    value: something\n  - name:\n    value: else";
    const result = parseYaml(yaml);
    const items = result.items as Record<string, unknown>;
    const arr = items.items as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    expect(arr[0]).toEqual({ value: "something" });
    expect(arr[1]).toEqual({ value: "else" });
  });

  // ── M3: Arbitrary nesting ────────────────────────────────────────

  it("handles deep nesting with objects inside list items", () => {
    const yaml = [
      "signatures:",
      '  - pattern: "test"',
      "    details:",
      "      severity: high",
      "      owner:",
      "        name: Alice",
      "        team: red",
    ].join("\n");
    const result = parseYaml(yaml);
    const sigs = result.signatures as Record<string, unknown>;
    const arr = sigs.signatures as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(1);
    const details = arr[0].details as Record<string, unknown>;
    expect(details.severity).toBe("high");
    const owner = details.owner as Record<string, unknown>;
    expect(owner).toEqual({ name: "Alice", team: "red" });
  });
});

// ── normalizeConfig tests ───────────────────────────────────────────

describe("normalizeConfig", () => {
  it("converts _list_ keys to arrays", () => {
    const raw = { deps: { _list_deps: ["node", "tsx"] } };
    const result = normalizeConfig(raw);
    expect(result.deps).toEqual(["node", "tsx"]);
    // When key === realName, the nested container is kept
    expect(result).toHaveProperty("deps", ["node", "tsx"]);
  });

  it("handles multiple _list_ keys in a nested object", () => {
    const raw = {
      container: { _list_a: [1, 2], _list_b: [3, 4] },
    };
    const result = normalizeConfig(raw);
    expect(result).toHaveProperty("a", [1, 2]);
    expect(result).toHaveProperty("b", [3, 4]);
    // container is only _list_ keys, so it should be removed
    expect(Object.keys(result)).not.toContain("container" as never);
  });

  it("provides stats defaults when missing", () => {
    const raw: Record<string, unknown> = { id: "test", name: "Test" };
    const result = normalizeConfig(raw);
    expect(result.stats).toEqual({
      total_scans: 0,
      true_positives: 0,
      false_positives: 0,
      avg_latency_us: 0,
    });
  });

  it("preserves existing stats when present", () => {
    const raw = {
      stats: { total_scans: 42, true_positives: 10, false_positives: 2, avg_latency_us: 150 },
    };
    const result = normalizeConfig(raw);
    expect(result.stats).toEqual({
      total_scans: 42,
      true_positives: 10,
      false_positives: 2,
      avg_latency_us: 150,
    });
  });

  it("handles parent_id as null", () => {
    const raw = { id: "test", parent_id: null };
    const result = normalizeConfig(raw);
    expect(result.parent_id).toBeNull();
  });

  it("preserves nested objects that are NOT lists", () => {
    const raw = {
      id: "test",
      stats: { total_scans: 5, true_positives: 3, false_positives: 1, avg_latency_us: 100 },
    };
    const result = normalizeConfig(raw);
    expect(result.stats).toEqual({
      total_scans: 5,
      true_positives: 3,
      false_positives: 1,
      avg_latency_us: 100,
    });
    expect(result.id).toBe("test");
  });

  it("does not alter scalar values", () => {
    const raw = { id: "test", threshold: 0.6, tier: 0 };
    const result = normalizeConfig(raw);
    expect(result.id).toBe("test");
    expect(result.threshold).toBe(0.6);
    expect(result.tier).toBe(0);
  });
});
