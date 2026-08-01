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
 * Before hooks block malicious input; post hooks (PostToolUse) can only
 * flag malicious tool output — the tool has already run.
 *
 * No LLM dependency — designed for sub-second hook latency.
 */

import { runTier0 } from "./scanner.js";
import { loadAntibodies } from "./library.js";
import type { ScriptResult } from "./schema.js";
import { appendStatsEvent } from "./evolution/stats-events.js";

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

/** Scan payload cap for hook input (defense against huge outputs). */
const MAX_SCAN_BYTES = 64 * 1024;

export interface HookDecision {
  output: HookOutput;
  exitCode: number;
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
  const decision = await decideHook(input!);
  respond(decision.output, decision.exitCode);
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Core hook decision logic (exported for tests).
 * KEYPOINT-REVIEW: post hooks never block — malicious tool output is
 * flagged because the tool has already executed.
 */
export async function decideHook(input: HookInput): Promise<HookDecision> {
  const content = buildContent(input);
  if (content) {
    appendStatsEvent("agent_behavior", "tool_payload_bytes", content.length, {
      tool: input.tool,
      post: input.post === true,
    });
  }
  if (!content || content.trim().length === 0) {
    return { output: { action: "allow", reason: "no scannable content" }, exitCode: 0 };
  }

  const antibodies = loadAntibodies();
  const tier0Only = antibodies.filter(
    (ab: { config: { tier: number }; scriptPath: string | null }) =>
      ab.config.tier === 0 && ab.scriptPath,
  );
  if (tier0Only.length === 0) {
    return { output: { action: "allow", reason: "no Tier 0 antibodies loaded" }, exitCode: 0 };
  }

  const { results, malicious } = await runTier0(
    tier0Only,
    content.slice(0, MAX_SCAN_BYTES),
    500,
  );

  if (malicious) {
    const matched = results
      .filter((r: ScriptResult) => r.verdict === "malicious")
      .map((r: ScriptResult) => r.antibody_id)
      .join(", ");
    if (input.post === true) {
      return {
        output: {
          action: "flag",
          reason: `post-tool output may be malicious (detected by: ${matched})`,
        },
        exitCode: 0,
      };
    }
    return {
      output: { action: "block", reason: `malicious content detected by: ${matched}` },
      exitCode: 1,
    };
  }

  const suspicious = results.filter((r: ScriptResult) => r.verdict === "suspicious");
  if (suspicious.length > 0) {
    return {
      output: {
        action: "flag",
        reason: `suspicious content flagged by: ${suspicious.map((r: ScriptResult) => r.antibody_id).join(", ")}`,
      },
      exitCode: 0,
    };
  }

  return { output: { action: "allow", reason: "content passed Tier 0 scan" }, exitCode: 0 };
}

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
