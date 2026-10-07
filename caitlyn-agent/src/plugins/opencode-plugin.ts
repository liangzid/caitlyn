/**
 * CAITLYN OpenCode Plugin — `@caitlyn/opencode-plugin`
 *
 * Registers tool.execute.before and tool.execute.after hooks in OpenCode's
 * plugin API. Delegates scanning to the caitlyn-hook binary.
 *
 * Install: `caitlyn install opencode` copies this file and updates config.
 */

import { spawnSync } from "node:child_process";

// ── PluginApi type (provided by OpenCode at runtime) ──────────────

interface OpenCodePluginApi {
  on(event: string, handler: (ctx: Record<string, unknown>) => Promise<void>): void;
}

// ── Scanner ───────────────────────────────────────────────────────

interface HookDecision {
  action: "allow" | "block" | "flag";
  reason: string;
  sanitizedContent?: string;
  restoredContent?: string;
}

function scanContent(tool: string, content: string): HookDecision {
  try {
    const input = JSON.stringify({ tool, content });
    const result = spawnSync("caitlyn-hook", [], {
      input,
      timeout: 5000,
      encoding: "utf-8",
    });
    if (result.error || result.status === null) {
      return { action: "allow", reason: "hook binary unavailable" };
    }
    const output = JSON.parse(result.stdout.trim());
    return {
      action: output.action,
      reason: output.reason || "scanned by CAITLYN",
      sanitizedContent: output.sanitizedContent,
      restoredContent: output.restoredContent,
    };
  } catch {
    return { action: "allow", reason: "scan error — allowing" };
  }
}

// ── Plugin Entry ──────────────────────────────────────────────────

export default function main(api: OpenCodePluginApi): void {
  // Before tool execution
  api.on("tool.execute.before", async (ctx: Record<string, unknown>) => {
    const input = (ctx.input || ctx) as { tool?: string; args?: Record<string, unknown> };
    const toolName = input.tool || "unknown";
    const content = input.args ? JSON.stringify(input.args) : "";
    const decision = scanContent(toolName, content);

    if (decision.action === "block") {
      throw new Error(`[CAITLYN] ${decision.reason}`);
    }
    // KEYPOINT-REVIEW: restored JSON replaces the tool arguments in place.
    if (decision.restoredContent && input.args) {
      try {
        const parsed = JSON.parse(decision.restoredContent) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          input.args = parsed as Record<string, unknown>;
        }
      } catch {
        // Keep the arguments the model produced.
      }
    }
  });

  // After tool execution
  api.on("tool.execute.after", async (ctx: Record<string, unknown>) => {
    const input = (ctx.input || ctx) as { tool?: string };
    const output = (ctx as { output?: { output?: string } }).output || {};
    const toolName = input.tool || "unknown";
    const content = output.output || "";
    const decision = scanContent(toolName, content);

    if (decision.action === "block") {
      (output as Record<string, unknown>).output = `[CAITLYN BLOCKED] ${decision.reason}`;
    } else if (decision.action === "flag") {
      (output as Record<string, unknown>).output = `[CAITLYN FLAGGED] ${output.output || ""}`;
    } else if (decision.sanitizedContent) {
      (output as Record<string, unknown>).output = decision.sanitizedContent;
    }
  });
}
