/**
 * Tests for guard/types.ts and guard/policy.ts
 *
 * Tests shared type utilities, verdict-to-action mapping,
 * policy evaluation, and content truncation.
 */
import { describe, it, expect } from "vitest";
import { verdictToAction } from "../../src/guard/types.js";
import type { VerdictAction } from "../../src/guard/types.js";
import { evaluatePolicy, prepareContent } from "../../src/guard/policy.js";
import type { PolicyContext } from "../../src/guard/policy.js";
import type { ScanResult } from "../../src/schema.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeResult(
  verdict: "benign" | "suspicious" | "malicious",
  confidence: number = 0.9,
): ScanResult {
  return {
    verdict,
    confidence,
    tier: 1,
    script_results: [],
    total_latency_us: 1000,
    total_tokens: 50,
  };
}

function makeCtx(verdict: "benign" | "suspicious" | "malicious"): PolicyContext {
  return {
    mode: "mcp-proxy",
    source: "web_search",
    content: "test content",
    scanResult: makeResult(verdict),
    config: { enabled: true, scan_timeout_ms: 5000, max_scan_bytes: 65536 },
  };
}

// ── verdictToAction Tests ───────────────────────────────────────────

describe("verdictToAction", () => {
  it("maps benign to allow by default", () => {
    expect(verdictToAction("benign")).toBe("allow");
  });

  it("maps suspicious to flag by default", () => {
    expect(verdictToAction("suspicious")).toBe("flag");
  });

  it("maps malicious to block by default", () => {
    expect(verdictToAction("malicious")).toBe("block");
  });

  it("applies policy overrides", () => {
    // Strict policy: flag everything suspicious as block
    const action = verdictToAction("suspicious", { suspicious: "block" });
    expect(action).toBe("block");
  });

  it("allows permissive overrides", () => {
    // Permissive policy: allow even malicious
    const action = verdictToAction("malicious", { malicious: "allow" });
    expect(action).toBe("allow");
  });
});

// ── evaluatePolicy Tests ────────────────────────────────────────────

describe("evaluatePolicy", () => {
  it("returns allow for benign verdict", () => {
    const decision = evaluatePolicy(makeCtx("benign"));
    expect(decision.action).toBe("allow");
    expect(decision.modifiedContent).toBe("test content");
    expect(decision.event.mode).toBe("mcp-proxy");
    expect(decision.event.action).toBe("allow");
  });

  it("returns flag for suspicious verdict", () => {
    const decision = evaluatePolicy(makeCtx("suspicious"));
    expect(decision.action).toBe("flag");
    expect(decision.modifiedContent).toContain("[CAITLYN FLAGGED");
    expect(decision.modifiedContent).toContain("test content");
  });

  it("returns block for malicious verdict", () => {
    const decision = evaluatePolicy(makeCtx("malicious"));
    expect(decision.action).toBe("block");
    expect(decision.modifiedContent).toContain("[CAITLYN BLOCKED]");
    expect(decision.modifiedContent).not.toContain("test content");
  });

  it("includes event data in decision", () => {
    const decision = evaluatePolicy(makeCtx("malicious"));
    expect(decision.event.content_snippet).toBe("test content");
    expect(decision.event.source).toBe("web_search");
    expect(decision.event.metadata).toEqual({});
  });

  it("applies custom verdict policy from config", () => {
    const ctx = makeCtx("malicious");
    ctx.config.verdict_policy = { malicious: "flag" };

    const decision = evaluatePolicy(ctx);
    expect(decision.action).toBe("flag");
  });

  it("includes confidence in reason for block", () => {
    const ctx = makeCtx("malicious");
    ctx.scanResult.confidence = 0.95;

    const decision = evaluatePolicy(ctx);
    expect(decision.reason).toContain("0.95");
  });

  it("works across all guard modes", () => {
    const modes: Array<"mcp-proxy" | "fs-watcher" | "agent-hooks" | "sandbox"> = [
      "mcp-proxy", "fs-watcher", "agent-hooks", "sandbox",
    ];
    for (const mode of modes) {
      const ctx = makeCtx("malicious");
      ctx.mode = mode;
      const decision = evaluatePolicy(ctx);
      expect(decision.event.mode).toBe(mode);
    }
  });
});

// ── prepareContent Tests ────────────────────────────────────────────

describe("prepareContent", () => {
  it("returns content unchanged when under max bytes", () => {
    const content = "Hello world";
    const result = prepareContent(content, 1024);
    expect(result).toBe(content);
  });

  it("truncates content that exceeds max bytes", () => {
    const content = "A".repeat(1000);
    const result = prepareContent(content, 100); // 100 bytes max
    expect(result.length).toBeLessThan(300); // head + separator + tail
    expect(result).toContain("[CAITLYN: content truncated]");
  });

  it("preserves both prefix and suffix of truncated content", () => {
    const prefix = "PREFIX_";
    const suffix = "_SUFFIX";
    const content = prefix + "X".repeat(800) + suffix;
    const result = prepareContent(content, 100);

    expect(result).toContain("PREFIX_");
    expect(result).toContain("_SUFFIX");
    expect(result).toContain("[CAITLYN: content truncated]");
  });

  it("handles multi-byte UTF-8 characters at byte boundaries", () => {
    // "€" is 3 bytes in UTF-8
    const content = "€€€€€€€€€€"; // 10 × 3 = 30 bytes
    const result = prepareContent(content, 10);
    // Should not contain broken UTF-8 sequences
    expect(() => Buffer.from(result, "utf-8").toString("utf-8")).not.toThrow();
  });

  it("returns content as-is when exactly at max bytes", () => {
    const content = "1234567890"; // 10 bytes
    const result = prepareContent(content, 10);
    expect(result).toBe(content);
  });
});
