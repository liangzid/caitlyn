/**
 * Tests for scanner.ts — prompt building and response parsing.
 */
import { describe, it, expect } from "vitest";
import { buildTier1Prompt, parseTier1Response } from "../src/scanner.js";
import type { AntibodyEntry, AntigenEntry } from "../src/schema.js";

// ── Test Helpers ────────────────────────────────────────────────────

function makeAntibody(id: string, name: string, readme: string): AntibodyEntry {
  return {
    config: {
      id,
      name,
      category: "injection",
      tier: 1 as const,
      threshold: 0.7,
      description: `Description for ${name}`,
      affinity_score: 0.5,
      created_at: "2025-01-01",
      parent_id: null,
      generation: 0,
      deps: [],
      signatures: [],
      stats: { total_scans: 0, true_positives: 0, false_positives: 0, avg_latency_us: 0 },
    },
    readme,
    scriptPath: null,
    folderPath: `/fake/antibodies/${id}`,
  };
}

function makeAntigen(id: string, name: string, payload: string): AntigenEntry {
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
    readme: `Antigen ${id} readme`,
    payload,
    folderPath: `/fake/antigens/${id}`,
  };
}

// ── buildTier1Prompt Tests ──────────────────────────────────────────

describe("buildTier1Prompt", () => {
  it("returns system prompt with antibody and antigen sections", () => {
    const ab = makeAntibody("ab-1", "SQL Injection Detector", "Detects SQL injection patterns.");
    const ag = makeAntigen("ag-1", "SQLi Bypass", "SELECT * FROM users WHERE 1=1");
    const content = "hello world";

    const { systemPrompt, userPrompt } = buildTier1Prompt([ab], [ag], content);

    // System prompt contains expected sections
    expect(systemPrompt).toContain("<antibody_library>");
    expect(systemPrompt).toContain("</antibody_library>");
    expect(systemPrompt).toContain("<antigen_library>");
    expect(systemPrompt).toContain("</antigen_library>");

    // Contains antibody and antigen details
    expect(systemPrompt).toContain("[ab-1]");
    expect(systemPrompt).toContain("SQL Injection Detector");
    expect(systemPrompt).toContain("Detects SQL injection patterns.");
    expect(systemPrompt).toContain("[ag-1]");
    expect(systemPrompt).toContain("SQLi Bypass");

    // Contains the output format instruction
    expect(systemPrompt).toContain('"malicious <number>"');
    expect(systemPrompt).toContain('"suspicious <number>"');

    // User prompt wraps content
    expect(userPrompt).toContain("<content>");
    expect(userPrompt).toContain("</content>");
    expect(userPrompt).toContain("hello world");
  });

  it("handles empty antibody and antigen arrays", () => {
    const { systemPrompt } = buildTier1Prompt([], [], "test");

    expect(systemPrompt).toContain("<antibody_library>");
    expect(systemPrompt).toContain("<antigen_library>");
    // No antibody/antigen entries within the XML sections
    const abSection = systemPrompt.match(/<antibody_library>\n([\s\S]*?)<\/antibody_library>/);
    const abBody = abSection?.[1] ?? "";
    expect(abBody).not.toContain("### [");
    const agSection = systemPrompt.match(/<antigen_library>\n([\s\S]*?)<\/antigen_library>/);
    const agBody = agSection?.[1] ?? "";
    expect(agBody).not.toContain("### [");
  });

  it("includes antigen escapes when present", () => {
    const ag = makeAntigen("ag-escapes", "Escapes Test", "malicious");
    ag.config.escapes = ["base64", "rot13", "unicode"];

    const { systemPrompt } = buildTier1Prompt([], [ag], "test");

    expect(systemPrompt).toContain("Known escapes: base64, rot13, unicode");
  });

  it("omits escapes line when antigen has no escapes", () => {
    const ag = makeAntigen("ag-no-esc", "No Escapes", "harmless");
    ag.config.escapes = [];

    const { systemPrompt } = buildTier1Prompt([], [ag], "test");

    expect(systemPrompt).not.toContain("Known escapes");
  });

  it("includes antigen payload in code block when present", () => {
    const ag = makeAntigen("ag-payload", "Has Payload", "DROP TABLE users;");

    const { systemPrompt } = buildTier1Prompt([], [ag], "test");

    expect(systemPrompt).toContain("```");
    expect(systemPrompt).toContain("DROP TABLE users;");
  });

  it("omits code block when antigen payload is empty", () => {
    const ag = makeAntigen("ag-no-payload", "No Payload", "");
    ag.payload = "";

    const { systemPrompt } = buildTier1Prompt([], [ag], "test");

    // Should not have ``` markers since payload is empty
    const occurrences = (systemPrompt.match(/```/g) || []).length;
    expect(occurrences).toBe(0);
  });

  it("includes multiple antibodies correctly", () => {
    const abs = [
      makeAntibody("ab-a", "Alpha", "Alpha defense desc."),
      makeAntibody("ab-b", "Beta", "Beta defense desc."),
    ];

    const { systemPrompt } = buildTier1Prompt(abs, [], "test");

    expect(systemPrompt).toContain("[ab-a]");
    expect(systemPrompt).toContain("Alpha defense desc.");
    expect(systemPrompt).toContain("[ab-b]");
    expect(systemPrompt).toContain("Beta defense desc.");
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
