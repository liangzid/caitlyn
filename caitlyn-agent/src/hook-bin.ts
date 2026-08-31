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
 * All decision logic lives in AgentHooksEngine (single guard
 * implementation); this binary is only an adapter between the hook
 * protocol and the engine. No LLM dependency — Tier 1 degrades.
 */

import {
  AgentHooksEngine,
  DEFAULT_AGENT_HOOKS_CONFIG,
  type AgentHooksConfig,
} from "./guard/agent-hooks.js";
import { createUnavailableLlmCall } from "./scanner.js";
import { appendStatsEvent } from "./evolution/stats-events.js";
import type { VerdictPolicy } from "./guard/types.js";
import { loadConfig, loadGuardRuntimeConfig, loadScanningConfig } from "./config.js";
import { checkProviderAuth } from "./config/credentials.js";
import { createConfiguredLlmCall } from "./llm-runtime.js";

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

/** Post hooks flag malicious output; they cannot block a finished tool. */
const POST_VERDICT_POLICY: VerdictPolicy = {
  benign: "allow",
  suspicious: "flag",
  malicious: "flag",
};

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

  const runtime = loadGuardRuntimeConfig();
  const scanning = loadScanningConfig();
  const verdictPolicy: VerdictPolicy = input.post === true
    ? POST_VERDICT_POLICY
    : {
        benign: "allow",
        suspicious: runtime.suspiciousAction,
        malicious: runtime.maliciousAction,
      };
  const engine = new AgentHooksEngine(
    {
      ...DEFAULT_AGENT_HOOKS_CONFIG,
      enabled: runtime.enabled,
      before_enabled: runtime.beforeEnabled,
      after_enabled: runtime.afterEnabled,
      max_scan_bytes: runtime.maxScanBytes,
      scan_timeout_ms: runtime.hookTimeoutMs,
      hook_timeout_ms: runtime.hookTimeoutMs,
      on_error: runtime.onError,
      verdict_policy: verdictPolicy,
    } as AgentHooksConfig,
    createHookLlmCall(scanning.skipTier1),
  );
  const decision = await engine.processHook({
    hookPoint: input.post === true ? "after" : "before",
    toolName: input.tool,
    content,
    toolArgs: input.args as Record<string, unknown> | undefined,
    toolResult: input.content,
  });
  return {
    output: { action: decision.action, reason: decision.reason },
    exitCode: decision.action === "block" ? 1 : 0,
  };
}

/**
 * Use a live LLM only when Tier 1 is enabled and credentials exist.
 * KEYPOINT: empty operator homes must degrade to Tier 0 instead of treating
 * an unauthenticated Tier 1 parse as suspicious.
 */
function createHookLlmCall(skipTier1: boolean): ReturnType<typeof createConfiguredLlmCall> {
  if (skipTier1) return createUnavailableLlmCall("hook-bin: Tier 1 disabled");
  const config = loadConfig();
  const auth = checkProviderAuth(config.provider);
  if (!auth.runtime && !auth.persisted && !auth.env) {
    return createUnavailableLlmCall("hook-bin: no provider credentials");
  }
  return createConfiguredLlmCall(config);
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
