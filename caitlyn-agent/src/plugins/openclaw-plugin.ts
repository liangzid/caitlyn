/**
 * CAITLYN OpenClaw Plugin — `@caitlyn/openclaw-plugin`
 *
 * Registers before_tool_call and after_tool_call hooks in OpenClaw's
 * plugin API. Delegates scanning to the caitlyn-hook binary.
 *
 * Install: `caitlyn install openclaw` copies this file and updates config.
 */

import { spawnSync } from "node:child_process";

interface HookDecision {
  action: "allow" | "block" | "flag";
  reason: string;
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
    };
  } catch {
    return { action: "allow", reason: "scan error — allowing" };
  }
}

// ── PluginApi type (provided by OpenClaw at runtime) ─────────────

interface OpenClawPluginApi {
  on(
    event: string,
    handler: (ctx: unknown) => Promise<{ action?: string; reason?: string } | void>,
  ): void;
}

// ── Plugin Entry ──────────────────────────────────────────────────

export default function main(api: OpenClawPluginApi): void {
  // Before tool call → can deny
  api.on("before_tool_call", async (ctx: unknown) => {
    const c = ctx as { tool?: string; args?: Record<string, unknown> };
    const toolName = c.tool || "unknown";
    const content = c.args ? JSON.stringify(c.args) : "";
    const decision = scanContent(toolName, content);

    if (decision.action === "block") {
      return { action: "deny", reason: `[CAITLYN] ${decision.reason}` };
    }
    return { action: "allow" };
  });

  // After tool call → audit only
  api.on("after_tool_call", async (ctx: unknown) => {
    const c = ctx as { tool?: string; result?: unknown };
    const toolName = c.tool || "unknown";
    const content =
      typeof c.result === "string" ? c.result : JSON.stringify(c.result || "");
    const decision = scanContent(toolName, content);

    if (decision.action === "block") {
      console.error(
        `[CAITLYN] Blocked tool output from ${toolName}: ${decision.reason}`,
      );
    }
  });
}
