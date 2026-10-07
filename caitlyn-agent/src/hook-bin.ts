#!/usr/bin/env node
/**
 * CAITLYN Hook Binary — `caitlyn-hook`
 *
 * External command invoked by CLI agent hook systems (Claude Code,
 * Codex CLI, Hermes Agent). Reads a JSON event on stdin, runs Tier 0
 * scan (regex + precompiled .mjs scripts), writes a JSON decision
 * to stdout.
 *
 * Plugin protocol (no host argument):
 *   stdin  → { "tool": string, "args"?: object, "content"?: string }
 *   stdout → { "action": "allow" | "block" | "flag", "reason": string }
 *   exit 0 → allow/flag
 *   exit 1 → block
 *
 * Claude Code and Codex (`caitlyn-hook claude|codex`):
 *   stdin is the host event (`tool_name`, `tool_input`, `hook_event_name`).
 *   A block prints PreToolUse `permissionDecision: deny` and exits 0.
 *   That reason is what the host shows the model. Allow prints nothing.
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
  /** Tool output the model should read, with secrets removed. */
  sanitizedContent?: string;
  /** Tool arguments with local surrogates restored. */
  restoredContent?: string;
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
  /** True when the event is a post-tool hook. */
  post?: boolean;
}

/** Hosts whose command-hook stdout is a permission decision, not the plugin JSON. */
export type CommandHookHost = "plugin" | "claude" | "codex";

export interface RenderedHookResponse {
  stdout: string;
  exitCode: number;
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const invocation = parseHookArgv(process.argv.slice(2));
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    emit(invocation.host, { output: { action: "allow", reason: "empty input — allowing" }, exitCode: 0 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    emit(invocation.host, { output: { action: "allow", reason: "invalid JSON input — allowing" }, exitCode: 0 });
  }

  const input = normalizeHookInput(parsed, invocation.post);
  const decision = await decideHook(input);
  emit(invocation.host, decision);
}

/**
 * `caitlyn-hook claude --post` selects the host protocol.
 * KEYPOINT-REVIEW: unknown arguments stay on the plugin JSON protocol.
 */
export function parseHookArgv(argv: string[]): { host: CommandHookHost; post: boolean } {
  const host: CommandHookHost = argv.includes("codex")
    ? "codex"
    : argv.includes("claude")
      ? "claude"
      : "plugin";
  return { host, post: argv.includes("--post") };
}

/**
 * Map a plugin payload or a Claude/Codex hook event onto HookInput.
 * Host events carry `tool_name` and `tool_input` rather than `tool` and `content`.
 */
export function normalizeHookInput(raw: unknown, postFlag: boolean): HookInput {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const eventName = typeof record.hook_event_name === "string" ? record.hook_event_name : "";
  const post = postFlag || record.post === true || eventName === "PostToolUse";
  const tool = firstString(record.tool, record.tool_name) || "unknown";
  if (typeof record.content === "string") {
    return { tool, content: record.content, args: record.args, post };
  }
  const payload = post
    ? record.tool_response ?? record.tool_input ?? record.args
    : record.tool_input ?? record.args;
  const serialized = payload === undefined
    ? ""
    : typeof payload === "string"
      ? payload
      : JSON.stringify(payload);
  return { tool, content: serialized, args: record.args ?? record.tool_input, post };
}

/**
 * Plugin hosts keep `{action, reason}` and exit 1 on block.
 * Claude Code and Codex show `permissionDecisionReason` to the model only
 * when the decision is deny, and they ignore that JSON if the process exits 2.
 * KEYPOINT-REVIEW: allow and flag therefore write no stdout.
 */
export function renderHostHookResponse(
  host: CommandHookHost,
  decision: HookDecision,
): RenderedHookResponse {
  if (host === "plugin") {
    return {
      stdout: JSON.stringify(decision.output) + "\n",
      exitCode: decision.exitCode,
    };
  }
  if (decision.output.action !== "block") {
    const rewritten = renderPrivacyRewrite(decision);
    if (rewritten) return { stdout: rewritten, exitCode: 0 };
    return { stdout: "", exitCode: 0 };
  }
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[CAITLYN] ${decision.output.reason}`,
      },
    }) + "\n",
    exitCode: 0,
  };
}

/**
 * Ask Claude Code or Codex to substitute sanitized tool output or restored
 * tool input. Allow and flag stay silent when nothing was rewritten.
 *
 * KEYPOINT-REVIEW: PreToolUse `updatedInput` is applied only together with
 * `permissionDecision: "allow"`, and that approves this one call. Codex
 * receives the same JSON. If a Codex build ignores `updatedToolOutput`,
 * post-tool secrets are not rewritten on that host.
 */
function renderPrivacyRewrite(decision: HookDecision): string | null {
  if (decision.post && decision.output.sanitizedContent) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: decision.output.sanitizedContent,
      },
    }) + "\n";
  }
  if (!decision.post && decision.output.restoredContent) {
    const updatedInput = parseToolInput(decision.output.restoredContent);
    if (updatedInput === undefined) return null;
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput,
      },
    }) + "\n";
  }
  return null;
}

/**
 * Parse restored tool arguments. A non-object payload is refused so a
 * partial rewrite cannot drop fields the host still needs.
 */
function parseToolInput(text: string): unknown | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON. The host keeps the original tool input.
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function emit(host: CommandHookHost, decision: HookDecision): never {
  const rendered = renderHostHookResponse(host, decision);
  process.stdout.write(rendered.stdout);
  process.exit(rendered.exitCode);
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
      privacy_enabled: runtime.privacyEnabled,
      privacy_level: runtime.privacyLevel,
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
  const output: HookOutput = { action: decision.action, reason: decision.reason };
  if (decision.sanitizedContent) output.sanitizedContent = decision.sanitizedContent;
  if (decision.restoredContent) output.restoredContent = decision.restoredContent;
  return {
    output,
    exitCode: decision.action === "block" ? 1 : 0,
    post: input.post === true,
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

main().catch((err) => {
  // Fail-open: a crash allows the tool call. Host adapters stay silent.
  const invocation = parseHookArgv(process.argv.slice(2));
  emit(invocation.host, {
    output: { action: "allow", reason: `hook error: ${String(err)}` },
    exitCode: 0,
  });
});
