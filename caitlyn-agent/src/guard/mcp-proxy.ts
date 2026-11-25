/**
 * CAITLYN Guard — MCP proxy enforcement.
 *
 * A transparent stdio MCP proxy scans tool arguments before the upstream
 * server executes them and scans tool results before the agent receives them.
 * The low-level Server API is intentional: tool schemas are dynamic because
 * they come from the upstream server at runtime.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentHooksEngine } from "./agent-hooks.js";

/** Extract the model-readable text represented by an MCP tool result. */
export function callToolResultScanText(result: CallToolResult): string {
  const parts = (result.content ?? [])
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "resource" && "text" in block.resource) return block.resource.text;
      return `[${block.type} content]`;
    });
  if (result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return parts.join("\n");
}

function textOnlyResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

function replaceWithText(result: CallToolResult, text: string): CallToolResult {
  const replaced = {
    ...result,
    content: [{ type: "text" as const, text }],
    isError: true,
  };
  delete replaced.structuredContent;
  return replaced;
}

function replaceWithSanitizedText(result: CallToolResult, text: string): CallToolResult {
  const replaced = {
    ...result,
    content: [{ type: "text" as const, text }],
  };
  delete replaced.structuredContent;
  return replaced;
}

function parseRestoredArguments(
  restored: string | undefined,
  original: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!restored) return original;
  try {
    const parsed = JSON.parse(restored) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Keep the model-produced arguments when the rewrite is not valid JSON.
  }
  return original;
}

function prependWarning(result: CallToolResult, reason: string): CallToolResult {
  return {
    ...result,
    content: [
      { type: "text", text: `[CAITLYN FLAGGED] ${reason}` },
      ...(result.content ?? []),
    ],
  };
}

/**
 * Forward one MCP tool call through the enforcement engine.
 *
 * KEYPOINT-REVIEW: a malicious pre-call decision prevents upstream execution.
 * A malicious post-call decision replaces only the returned content; the side
 * effect has already happened and is reported as blocked rather than hidden.
 */
export async function scanMcpToolCall(
  upstreamClient: Client,
  engine: AgentHooksEngine,
  params: CallToolRequest["params"],
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const serializedArguments = JSON.stringify(params.arguments ?? {});
  const before = await engine.processHook({
    hookPoint: "before",
    toolName: params.name,
    content: serializedArguments,
    toolArgs: params.arguments,
  });
  if (before.action === "block") {
    return textOnlyResult(`[CAITLYN BLOCKED] ${before.reason}`);
  }

  const forwardParams = {
    ...params,
    arguments: parseRestoredArguments(before.restoredContent, params.arguments),
  };
  const upstreamResult = await upstreamClient.callTool(
    forwardParams,
    undefined,
    { signal },
  ) as CallToolResult;
  const outputText = callToolResultScanText(upstreamResult);
  const after = await engine.processHook({
    hookPoint: "after",
    toolName: params.name,
    content: outputText,
    toolArgs: forwardParams.arguments,
    toolResult: upstreamResult,
  });
  const visibleResult = after.sanitizedContent
    ? replaceWithSanitizedText(upstreamResult, after.sanitizedContent)
    : upstreamResult;

  if (after.action === "block") {
    return replaceWithText(visibleResult, `[CAITLYN BLOCKED] ${after.reason}`);
  }
  if (after.action === "flag") {
    return prependWarning(visibleResult, after.reason);
  }
  return visibleResult;
}

/**
 * Create the downstream MCP server facade for an already connected upstream
 * client. The MVP intentionally exposes tools only; resources and prompts are
 * not advertised until they have the same enforcement boundary.
 */
export function createMcpProxyServer(
  upstreamClient: Client,
  engine: AgentHooksEngine,
): Server {
  const server = new Server(
    { name: "caitlyn-mcp-proxy", version: "0.7.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    upstreamClient.listTools(request.params),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    scanMcpToolCall(upstreamClient, engine, request.params, extra.signal),
  );
  return server;
}
