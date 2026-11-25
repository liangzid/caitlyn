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
import type { PrivacyLevel } from "../config.js";
import { protectOutbound, restoreInbound } from "../privacy/protect.js";

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

function protectText(text: string, level: PrivacyLevel): string {
  try {
    return protectOutbound(text, undefined, level).text;
  } catch {
    return text;
  }
}

function sanitizeValue(value: unknown, level: PrivacyLevel): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const sanitized = protectText(value, level);
    return { value: sanitized, changed: sanitized !== value };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const raw = String(value);
    const sanitized = protectText(raw, level);
    const numeric = Number(sanitized);
    const next = Number.isFinite(numeric) && sanitized.trim() !== "" ? numeric : sanitized;
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const sanitized = sanitizeValue(item, level);
      changed ||= sanitized.changed;
      return sanitized.value;
    });
    return { value: items, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const sanitized = sanitizeValue(item, level);
      changed ||= sanitized.changed;
      return [key, sanitized.value];
    });
    return { value: Object.fromEntries(entries), changed };
  }
  return { value, changed: false };
}

/** Sanitize model-visible fields without changing the MCP result shape. */
function sanitizeCallToolResult(
  result: CallToolResult,
  level: PrivacyLevel,
): { result: CallToolResult; changed: boolean } {
  let changed = false;
  const content = (result.content ?? []).map((block) => {
    if (block.type === "text") {
      const sanitized = sanitizeValue(block.text, level);
      changed ||= sanitized.changed;
      return sanitized.changed ? { ...block, text: sanitized.value as string } : block;
    }
    if (block.type === "resource" && "text" in block.resource && typeof block.resource.text === "string") {
      const sanitized = sanitizeValue(block.resource.text, level);
      changed ||= sanitized.changed;
      return sanitized.changed
        ? { ...block, resource: { ...block.resource, text: sanitized.value as string } } as typeof block
        : block;
    }
    return block;
  });

  let structuredContent = result.structuredContent;
  if (structuredContent !== undefined) {
    const sanitized = sanitizeValue(structuredContent, level);
    changed ||= sanitized.changed;
    structuredContent = sanitized.value as Record<string, unknown>;
  }
  return { result: { ...result, content, structuredContent }, changed };
}

function restoreSurrogateText(text: string): string {
  try {
    return restoreInbound(text).text;
  } catch {
    return text;
  }
}

function restoreSurrogatesInValue(value: unknown): unknown {
  if (typeof value === "string") return restoreSurrogateText(value);
  if (Array.isArray(value)) return value.map(restoreSurrogatesInValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        restoreSurrogatesInValue(item),
      ]),
    );
  }
  return value;
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

  const forwardArguments = before.restoredContent
    ? restoreSurrogatesInValue(params.arguments) as Record<string, unknown> | undefined
    : params.arguments;
  const forwardParams = {
    ...params,
    arguments: forwardArguments,
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
  let visibleResult = upstreamResult;
  if (after.sanitizedContent) {
    const privacy = engine.getPrivacySettings();
    const shaped = sanitizeCallToolResult(upstreamResult, privacy.level);
    // KEYPOINT-REVIEW: preserve structuredContent whenever shape-aware
    // masking found the same sensitive values. The flat string remains a
    // fail-safe for cross-boundary matches that no single field contains.
    visibleResult = shaped.changed
      ? shaped.result
      : replaceWithSanitizedText(upstreamResult, after.sanitizedContent);
  }

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
