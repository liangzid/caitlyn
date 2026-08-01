/**
 * CAITLYN Guard — Agent Hooks
 *
 * Framework-level middleware that intercepts tool calls in supported
 * agent frameworks. Hooks run before and after each tool invocation,
 * scanning arguments and results through the CAITLYN scanner.
 *
 * Supported frameworks:
 *   - pi-agent-core (native, via middleware API)
 *   - OpenClaw, Claude Code, Codex CLI, OpenCode (via adapter pattern)
 */

import type { ScanResult } from "../schema.js";
import { createUnavailableLlmCall, type LlmCallFn } from "../scanner.js";
import { hybridScan } from "../hybrid-scanner.js";
import type { GuardConfig, GuardEvent, VerdictAction } from "./types.js";
import { DEFAULT_GUARD_CONFIG } from "./types.js";
import { evaluatePolicy, prepareContent } from "./policy.js";

// ── Types ───────────────────────────────────────────────────────────

/** The hook point in the tool call lifecycle. */
export type HookPoint = "before" | "after";

/** Decision returned by a hook. */
export interface HookDecision {
  /** Whether the tool call should proceed. */
  action: "allow" | "block" | "flag";

  /** Human-readable reason for the decision. */
  reason: string;

  /** If action="flag" and hookPoint="after", the modified result. */
  modifiedResult?: string;

  /** Scan result (null if scan was skipped). */
  scanResult: ScanResult | null;
}

/** Context passed to a hook. */
export interface HookContext {
  /** Which point in the lifecycle. */
  hookPoint: HookPoint;

  /** The name of the tool being called. */
  toolName: string;

  /** Tool arguments (before) or tool result (after), as a string. */
  content: string;

  /** Raw tool arguments (before hook only). */
  toolArgs?: Record<string, unknown>;

  /** Raw tool result (after hook only). */
  toolResult?: unknown;
}

/** Statistics for agent hooks. */
export interface AgentHooksStats {
  totalHooks: number;
  beforeHooks: number;
  afterHooks: number;
  blocked: number;
  flagged: number;
  allowed: number;
  scanErrors: number;
  totalScanLatencyUs: number;
}

/** Configuration for agent hooks. */
export interface AgentHooksConfig extends GuardConfig {
  /** Hook timeout in milliseconds. */
  hook_timeout_ms: number;

  /** Whether to scan before tool calls. */
  before_enabled: boolean;

  /** Whether to scan after tool calls. */
  after_enabled: boolean;

  /** Tool names to skip (no hooks fire for these). */
  skip_tools: string[];

  /** Tool names to only scan after (not before). */
  after_only_tools: string[];

  /** What to do on hook error or timeout. */
  on_error: "allow" | "block";
}

export const DEFAULT_AGENT_HOOKS_CONFIG: Partial<AgentHooksConfig> = {
  hook_timeout_ms: 5000,
  before_enabled: true,
  after_enabled: true,
  skip_tools: [],
  after_only_tools: [],
  on_error: "allow", // Fail-open for safety
};

// ── Agent Hook Interface ────────────────────────────────────────────

/**
 * Interface that every framework adapter must implement.
 *
 * Each supported agent framework (pi-agent-core, OpenClaw, Claude Code,
 * Codex CLI, OpenCode) needs a concrete adapter implementing this interface.
 */
export interface AgentHookAdapter {
  /** Framework name for logging. */
  readonly frameworkName: string;

  /**
   * Called before a tool executes.
   * Returns a decision; if action="block", the tool is not executed.
   */
  beforeToolCall(toolName: string, args: Record<string, unknown>): Promise<HookDecision>;

  /**
   * Called after a tool executes.
   * Returns a decision; modifiedResult replaces the tool's return value
   * if action="flag" or action="block".
   */
  afterToolCall(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
  ): Promise<HookDecision>;

  /** Get hook statistics. */
  getStats(): AgentHooksStats;
}

// ── Core Hook Engine ────────────────────────────────────────────────

/**
 * Core hook engine shared by all framework adapters.
 * Handles scanning and policy evaluation; adapters handle framework integration.
 */
export class AgentHooksEngine {
  private config: AgentHooksConfig;
  private stats: AgentHooksStats;
  private llmCall: LlmCallFn | null;

  constructor(config: Partial<AgentHooksConfig> = {}, llmCall: LlmCallFn | null = null) {
    this.config = {
      ...DEFAULT_GUARD_CONFIG,
      ...DEFAULT_AGENT_HOOKS_CONFIG,
      ...config,
    } as AgentHooksConfig;
    this.stats = this._freshStats();
    this.llmCall = llmCall;
  }

  /** Process a hook event — the core hook logic. */
  async processHook(ctx: HookContext): Promise<HookDecision> {
    if (!this.config.enabled) {
      return this._allow(ctx, null);
    }

    // Check disabled hook points
    if (ctx.hookPoint === "before" && !this.config.before_enabled) {
      return this._allow(ctx, null);
    }
    if (ctx.hookPoint === "after" && !this.config.after_enabled) {
      return this._allow(ctx, null);
    }

    // Check skip list
    if (this.config.skip_tools.includes(ctx.toolName)) {
      return this._allow(ctx, null);
    }

    // Check after_only list (skip before hook for these tools)
    if (ctx.hookPoint === "before" && this.config.after_only_tools.includes(ctx.toolName)) {
      return this._allow(ctx, null);
    }

    this.stats.totalHooks++;
    if (ctx.hookPoint === "before") this.stats.beforeHooks++;
    else this.stats.afterHooks++;

    // Scan
    let scanResult: ScanResult | null = null;
    try {
      const content = prepareContent(ctx.content, this.config.max_scan_bytes);

      const result = await Promise.race([
        hybridScan({
          content,
          // Tier 0 scripts never need the LLM: without one, run the unified
          // pipeline with a failing Tier 1 so tool calls are still scanned.
          llmCall: this.llmCall ?? createUnavailableLlmCall("LLM not configured"),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("hook scan timeout")),
            this.config.hook_timeout_ms,
          ),
        ),
      ]);

      scanResult = result;
    } catch (err) {
      this.stats.scanErrors++;
      if (this.config.onEvent) {
        this.config.onEvent({
          mode: "agent-hooks",
          content_snippet: ctx.content.slice(0, 256),
          scan_result: {
            verdict: "benign", confidence: 0, tier: 0,
            script_results: [], total_latency_us: 0, total_tokens: 0,
          },
          action: this.config.on_error,
          source: `${ctx.hookPoint}:${ctx.toolName}`,
          timestamp: new Date().toISOString(),
          metadata: { error: String(err), hookPoint: ctx.hookPoint },
        });
      }
      return {
        action: this.config.on_error,
        reason: `Hook error: ${String(err)}`,
        scanResult: null,
      };
    }

    // Evaluate policy
    const content = prepareContent(ctx.content, this.config.max_scan_bytes);
    const decision = evaluatePolicy({
      mode: "agent-hooks",
      source: `${ctx.hookPoint}:${ctx.toolName}`,
      content,
      scanResult,
      config: this.config,
    });

    // Fire event
    if (this.config.onEvent) {
      this.config.onEvent({
        ...decision.event,
        metadata: { hookPoint: ctx.hookPoint, toolName: ctx.toolName },
      });
    }

    // Update stats
    this.stats.totalScanLatencyUs += scanResult.total_latency_us;
    if (decision.action === "block") this.stats.blocked++;
    else if (decision.action === "flag") this.stats.flagged++;
    else this.stats.allowed++;

    return {
      action: decision.action,
      reason: decision.reason,
      modifiedResult: decision.modifiedContent,
      scanResult,
    };
  }

  /** Get hook statistics. */
  getStats(): AgentHooksStats {
    return { ...this.stats };
  }

  /** Reset statistics. */
  resetStats(): void {
    this.stats = this._freshStats();
  }

  /** Set the LLM call function. */
  setLlmCall(llmCall: LlmCallFn): void {
    this.llmCall = llmCall;
  }

  /** Update runtime configuration. */
  updateConfig(partial: Partial<AgentHooksConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private _allow(ctx: HookContext, scanResult: ScanResult | null): HookDecision {
    this.stats.totalHooks++;
    if (ctx.hookPoint === "before") this.stats.beforeHooks++;
    else this.stats.afterHooks++;
    this.stats.allowed++;
    return {
      action: "allow",
      reason: "Hook disabled or skipped",
      scanResult,
    };
  }

  private _freshStats(): AgentHooksStats {
    return {
      totalHooks: 0,
      beforeHooks: 0,
      afterHooks: 0,
      blocked: 0,
      flagged: 0,
      allowed: 0,
      scanErrors: 0,
      totalScanLatencyUs: 0,
    };
  }
}

// ── pi-agent-core Adapter ───────────────────────────────────────────

/**
 * Adapter for the pi-agent-core framework.
 *
 * pi-agent-core provides a middleware API where middleware functions
 * receive tool call context and can cancel/modify tool calls.
 *
 * Usage:
 *   const hooks = createPiAgentHookAdapter(engine);
 *   agent.use(hooks.middleware);
 */
export interface PiAgentToolContext {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  cancel: (reason: string) => void;
  setResult: (result: unknown) => void;
}

export type PiAgentMiddleware = (ctx: PiAgentToolContext, next: () => Promise<void>) => Promise<void>;

export function createPiAgentHookAdapter(engine: AgentHooksEngine): {
  middleware: PiAgentMiddleware;
  getStats: () => AgentHooksStats;
} {
  return {
    middleware: async (ctx: PiAgentToolContext, next: () => Promise<void>) => {
      // Before hook
      const argsText = JSON.stringify(ctx.args);
      const beforeDecision = await engine.processHook({
        hookPoint: "before",
        toolName: ctx.toolName,
        content: argsText,
        toolArgs: ctx.args,
      });

      if (beforeDecision.action === "block") {
        ctx.cancel(`[CAITLYN] ${beforeDecision.reason}`);
        return;
      }

      // Execute tool
      await next();

      // After hook
      const resultText =
        typeof ctx.result === "string"
          ? ctx.result
          : JSON.stringify(ctx.result);
      const afterDecision = await engine.processHook({
        hookPoint: "after",
        toolName: ctx.toolName,
        content: resultText,
        toolArgs: ctx.args,
        toolResult: ctx.result,
      });

      if (afterDecision.action === "block") {
        ctx.setResult(`[CAITLYN BLOCKED] ${afterDecision.reason}`);
      } else if (afterDecision.action === "flag" && afterDecision.modifiedResult) {
        ctx.setResult(afterDecision.modifiedResult);
      }
    },
    getStats: () => engine.getStats(),
  };
}

// ── Generic Adapter Factory ─────────────────────────────────────────

/**
 * Create a standalone hook pair for frameworks without native middleware.
 *
 * Call `beforeToolCall` before executing a tool, and `afterToolCall`
 * after receiving the result. The caller is responsible for wiring
 * these into their framework's tool execution lifecycle.
 */
export function createStandaloneHooks(engine: AgentHooksEngine): {
  beforeToolCall: (toolName: string, args: Record<string, unknown>) => Promise<HookDecision>;
  afterToolCall: (
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
  ) => Promise<HookDecision>;
  getStats: () => AgentHooksStats;
} {
  return {
    beforeToolCall: async (toolName, args) => {
      return engine.processHook({
        hookPoint: "before",
        toolName,
        content: JSON.stringify(args),
        toolArgs: args,
      });
    },
    afterToolCall: async (toolName, args, result) => {
      return engine.processHook({
        hookPoint: "after",
        toolName,
        content: typeof result === "string" ? result : JSON.stringify(result),
        toolArgs: args,
        toolResult: result,
      });
    },
    getStats: () => engine.getStats(),
  };
}
