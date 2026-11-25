#!/usr/bin/env node
/**
 * CAITLYN MCP Proxy Binary — `caitlyn-mcp-proxy`
 *
 * Runs a transparent stdio MCP proxy:
 *   agent client → caitlyn-mcp-proxy → upstream MCP server command
 *
 * Usage in an MCP server configuration:
 *   caitlyn-mcp-proxy -- <upstream-command> [upstream-args...]
 *
 * stdout is reserved for the MCP protocol. Diagnostics go to stderr.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  AgentHooksEngine,
  DEFAULT_AGENT_HOOKS_CONFIG,
  type AgentHooksConfig,
} from "./guard/agent-hooks.js";
import { createMcpProxyServer } from "./guard/mcp-proxy.js";
import { loadGuardRuntimeConfig, loadScanningConfig } from "./config.js";
import { createCredentialedLlmCall } from "./llm-runtime.js";
import { parseMcpProxyArgv } from "./mcp-proxy-args.js";

/** Build the shared enforcement engine from the operator configuration. */
export function createMcpProxyEngine(): AgentHooksEngine {
  const runtime = loadGuardRuntimeConfig();
  const scanning = loadScanningConfig();
  return new AgentHooksEngine(
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
      verdict_policy: {
        benign: "allow",
        suspicious: runtime.suspiciousAction,
        malicious: runtime.maliciousAction,
      },
    } as AgentHooksConfig,
    createCredentialedLlmCall(scanning.skipTier1, "mcp-proxy"),
  );
}

async function main(): Promise<void> {
  const upstream = parseMcpProxyArgv(process.argv.slice(2));
  if (!upstream) {
    process.stderr.write(
      "Usage: caitlyn-mcp-proxy -- <upstream-command> [upstream-args...]\n",
    );
    process.exit(2);
  }

  const upstreamClient = new Client({
    name: "caitlyn-mcp-proxy-upstream-client",
    version: "0.7.0",
  });
  // KEYPOINT-REVIEW: never forward scanner credentials wholesale. Operators
  // opt into upstream variables with CAITLYN_UPSTREAM_ENV_<NAME>; the proxy
  // strips that prefix before spawning the upstream server.
  const inheritedEnv: Record<string, string> = {};
  if (process.env.PATH) inheritedEnv.PATH = process.env.PATH;
  if (process.env.HOME) inheritedEnv.HOME = process.env.HOME;
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.startsWith("CAITLYN_UPSTREAM_ENV_")) {
      inheritedEnv[key.slice("CAITLYN_UPSTREAM_ENV_".length)] = value;
    }
  }
  const upstreamTransport = new StdioClientTransport({
    command: upstream.command,
    args: upstream.args,
    env: inheritedEnv,
    stderr: "inherit",
  });
  await upstreamClient.connect(upstreamTransport);

  const server = createMcpProxyServer(upstreamClient, createMcpProxyEngine());
  await server.connect(new StdioServerTransport());

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.allSettled([server.close(), upstreamClient.close()]);
    process.exit(0);
  };
  process.stdin.once("end", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  process.stderr.write(`caitlyn-mcp-proxy failed: ${String(error)}\n`);
  process.exit(1);
});
