#!/usr/bin/env node
/**
 * CAITLYN Hook Binary — `caitlyn-hook`
 *
 * External command invoked by CLI agent hook systems (Claude Code,
 * Codex CLI, Hermes Agent). Reads a JSON event on stdin, runs Tier 0
 * scan (regex + precompiled .mjs scripts), writes a JSON decision
 * to stdout.
 *
 * Protocol:
 *   stdin  → { "tool": string, "args"?: object, "content"?: string }
 *   stdout → { "action": "allow" | "block" | "flag", "reason": string }
 *   exit 0 → allow/flag
 *   exit 1 → block
 *
 * No LLM dependency — designed for sub-second hook latency.
 */

import { runTier0 } from "./scanner.js";
import { loadAntibodies } from "./library.js";
import type { ScriptResult } from "./schema.js";

interface HookInput {
  tool: string;
  args?: unknown;
  content?: string;
  /** If true, this is a PostToolUse hook (tool has already run). */
  post?: boolean;
}

interface HookOutput {
  action: "allow" | "block" | "flag";
  reason: string;
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    respond({ action: "allow", reason: "empty input — allowing" }, 0);
  }

  let input: HookInput;
  try {
    input = JSON.parse(raw);
  } catch {
    respond({ action: "allow", reason: "invalid JSON input — allowing" }, 0);
  }

  // Build scan content from hook input
  const content = buildContent(input!);
  if (!content || content.trim().length === 0) {
    respond({ action: "allow", reason: "no scannable content" }, 0);
  }

  // Run Tier 0 scan
  const antibodies = loadAntibodies();
  const tier0Only = antibodies.filter((ab: { config: { tier: number }; scriptPath: string | null }) => ab.config.tier === 0 && ab.scriptPath);

  if (tier0Only.length === 0) {
    respond({ action: "allow", reason: "no Tier 0 antibodies loaded" }, 0);
  }

  const { results, malicious } = await runTier0(tier0Only, content!, 500);

  if (malicious) {
    const matched = results
      .filter((r: ScriptResult) => r.verdict === "malicious")
      .map((r: ScriptResult) => r.antibody_id)
      .join(", ");
    respond({ action: "block", reason: `malicious content detected by: ${matched}` }, 1);
  }

  const suspicious = results.filter((r: ScriptResult) => r.verdict === "suspicious");
  if (suspicious.length > 0) {
    respond(
      {
        action: "flag",
        reason: `suspicious content flagged by: ${suspicious.map((r: ScriptResult) => r.antibody_id).join(", ")}`,
      },
      0,
    );
  }

  respond({ action: "allow", reason: "content passed Tier 0 scan" }, 0);
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildContent(input: HookInput): string {
  // If explicit content is provided, use it
  if (input.content) return input.content;

  // Otherwise, serialize tool name + args
  const parts = [input.tool];
  if (input.args) {
    parts.push(JSON.stringify(input.args));
  }
  return parts.join(" ");
}

function respond(output: HookOutput, exitCode: number): never {
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(exitCode);
}

main().catch((err) => {
  // Fail-open: any crash → allow
  respond(
    { action: "allow", reason: `hook error: ${String(err)}` },
    0,
  );
});
