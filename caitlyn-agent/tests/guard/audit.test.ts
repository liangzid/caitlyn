/**
 * Tests for privacy-safe structured guard audit logging.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendGuardAuditEvent,
  createGuardAuditLogger,
  resolveGuardAuditDir,
} from "../../src/guard/audit.js";
import type { GuardEvent } from "../../src/guard/types.js";

function event(snippet: string): GuardEvent {
  return {
    mode: "agent-hooks",
    content_snippet: snippet,
    scan_result: {
      verdict: "malicious",
      confidence: 0.95,
      tier: 0,
      script_results: [
        {
          defense_skill_id: "fixture-detector",
          verdict: "malicious",
          confidence: 0.95,
          reason: "raw detector explanation must not be copied",
          latency_us: 12,
          error: null,
        },
      ],
      total_latency_us: 12,
      total_tokens: 0,
    },
    action: "block",
    source: "before:bash",
    timestamp: "2026-11-25T00:00:00.000Z",
    metadata: { hookPoint: "before" },
  };
}

describe("guard audit logging", () => {
  it("writes structured JSONL without raw content or detector explanations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-audit-"));
    appendGuardAuditEvent(event("raw secret tool payload"), dir);

    const lines = fs.readFileSync(path.join(dir, "guard-events.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      schema_version: 1,
      mode: "agent-hooks",
      source: "before:bash",
      action: "block",
      scan: {
        verdict: "malicious",
        confidence: 0.95,
        detectors: [{ id: "fixture-detector", verdict: "malicious" }],
      },
      metadata: { hookPoint: "before" },
    });
    expect(record.content.snippet_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain("raw secret tool payload");
    expect(JSON.stringify(record)).not.toContain("raw detector explanation");
  });

  it("honors the enable switch and resolves configured directories", () => {
    expect(createGuardAuditLogger(false, null)).toBeUndefined();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-home-"));
    expect(resolveGuardAuditDir("~/audit-events")).toBe(path.join(os.homedir(), "audit-events"));
    expect(resolveGuardAuditDir(path.join(home, "audit"))).toBe(path.join(home, "audit"));
  });
});
