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
  type Progress,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentHooksEngine } from "./agent-hooks.js";
import type { PrivacyLevel } from "../config.js";
import { findPrivacySpans, protectOutbound, restoreInbound } from "../privacy/protect.js";

interface ScanPart {
  text: string;
  /** Offset inside `text` that the shape-aware sanitizer can rewrite. */
  atomicStart?: number;
  atomicEnd?: number;
}

function appendStructuredScanParts(
  value: unknown,
  keyPath: string,
  parts: ScanPart[],
): void {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const prefix = keyPath ? `${keyPath}: ` : "";
    const rendered = String(value);
    parts.push({
      text: `${prefix}${rendered}`,
      atomicStart: prefix.length,
      atomicEnd: prefix.length + rendered.length,
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendStructuredScanParts(item, `${keyPath}[${index}]`, parts));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      appendStructuredScanParts(item, keyPath ? `${keyPath}.${key}` : key, parts);
    }
  }
}

function resultScanParts(result: CallToolResult): ScanPart[] {
  const parts: ScanPart[] = (result.content ?? [])
    .flatMap((block): ScanPart[] => {
      if (block.type === "text") {
        return [{ text: block.text, atomicStart: 0, atomicEnd: block.text.length }];
      }
      if (block.type === "resource" && "text" in block.resource) {
        return [{
          text: block.resource.text,
          atomicStart: 0,
          atomicEnd: block.resource.text.length,
        }];
      }
      if (block.type === "resource_link") {
        return [block.name, block.title, block.description, block.uri]
          .filter((value): value is string => typeof value === "string")
          .map((value) => ({ text: value, atomicStart: 0, atomicEnd: value.length }));
      }
      return [{ text: `[${block.type} content]` }];
    });
  if (result.structuredContent !== undefined) {
    appendStructuredScanParts(result.structuredContent, "", parts);
  }
  return parts;
}

/** Extract the model-readable text represented by an MCP tool result. */
export function callToolResultScanText(result: CallToolResult): string {
  return resultScanParts(result).map((part) => part.text).join("\n");
}

function resultAtomicRanges(result: CallToolResult): Array<{ start: number; end: number }> {
  let offset = 0;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const part of resultScanParts(result)) {
    if (part.atomicStart !== undefined && part.atomicEnd !== undefined) {
      ranges.push({
        start: offset + part.atomicStart,
        end: offset + part.atomicEnd,
      });
    }
    offset += part.text.length + 1;
  }
  return ranges;
}

function insideAtomicRange(
  span: { start: number; end: number },
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((range) => span.start >= range.start && span.end <= range.end);
}

function shapeExpressibleSpan(
  span: { start: number; end: number; valueStart: number; valueEnd: number },
  spans: Array<{ start: number; end: number; valueStart: number; valueEnd: number }>,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  if (insideAtomicRange(span, ranges)) return true;
  return spans.some((other) =>
    other !== span
      && insideAtomicRange(other, ranges)
      && other.valueStart <= span.valueStart
      && other.valueEnd >= span.valueEnd
  );
}

function textOnlyResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

function replaceWithText(_result: CallToolResult, text: string): CallToolResult {
  // Blocked output must not carry upstream metadata or extension fields.
  return textOnlyResult(text);
}

function replaceWithSanitizedText(_result: CallToolResult, text: string): CallToolResult {
  // MCP clients skip output-schema validation for errors. This fallback is
  // only for cross-boundary privacy matches that cannot be shape-restored.
  // It also drops upstream metadata because redacting only model-visible text
  // would otherwise leave the same sensitive values in extension fields.
  return textOnlyResult(text);
}

function protectText(text: string, level: PrivacyLevel): string {
  try {
    return protectOutbound(text, undefined, level).text;
  } catch {
    return text;
  }
}

interface SanitizedValue {
  value: unknown;
  changed: boolean;
  /** False when privacy cannot round-trip inside the original JSON type. */
  shapeSafe: boolean;
}

function sanitizeValue(value: unknown, level: PrivacyLevel): SanitizedValue {
  if (typeof value === "string") {
    const sanitized = protectText(value, level);
    return { value: sanitized, changed: sanitized !== value, shapeSafe: true };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const raw = String(value);
    const sanitized = protectText(raw, level);
    const numeric = Number(sanitized);
    const roundTrips = Number.isFinite(numeric) && String(numeric) === sanitized;
    return roundTrips
      ? { value: numeric, changed: numeric !== value, shapeSafe: true }
      : { value: sanitized, changed: sanitized !== raw, shapeSafe: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    let shapeSafe = true;
    const items = value.map((item) => {
      const sanitized = sanitizeValue(item, level);
      changed ||= sanitized.changed;
      shapeSafe &&= sanitized.shapeSafe;
      return sanitized.value;
    });
    return { value: items, changed, shapeSafe };
  }
  if (value && typeof value === "object") {
    let changed = false;
    let shapeSafe = true;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const sanitized = sanitizeValue(item, level);
      changed ||= sanitized.changed;
      shapeSafe &&= sanitized.shapeSafe;
      return [key, sanitized.value];
    });
    return { value: Object.fromEntries(entries), changed, shapeSafe };
  }
  return { value, changed: false, shapeSafe: true };
}

/** Sanitize model-visible fields without changing the MCP result shape. */
function sanitizeCallToolResult(
  result: CallToolResult,
  level: PrivacyLevel,
): { result: CallToolResult; structuredChanged: boolean; shapeSafe: boolean; referenceChanged: boolean } {
  let shapeSafe = true;
  let referenceChanged = false;
  const content = (result.content ?? []).map((block) => {
    if (block.type === "text") {
      const sanitized = sanitizeValue(block.text, level);
      shapeSafe &&= sanitized.shapeSafe;
      return sanitized.changed ? { ...block, text: sanitized.value as string } : block;
    }
    if (block.type === "resource" && "text" in block.resource && typeof block.resource.text === "string") {
      const sanitized = sanitizeValue(block.resource.text, level);
      shapeSafe &&= sanitized.shapeSafe;
      return sanitized.changed
        ? { ...block, resource: { ...block.resource, text: sanitized.value as string } } as typeof block
        : block;
    }
    if (block.type === "resource_link") {
      let changed = false;
      const sanitizeField = (value: string | undefined): string | undefined => {
        if (value === undefined) return value;
        const sanitized = sanitizeValue(value, level);
        changed ||= sanitized.changed;
        shapeSafe &&= sanitized.shapeSafe;
        return sanitized.value as string;
      };
      const rewritten = {
        ...block,
        name: sanitizeField(block.name) ?? block.name,
        title: sanitizeField(block.title),
        description: sanitizeField(block.description),
        uri: sanitizeField(block.uri) ?? block.uri,
      };
      referenceChanged ||= rewritten.uri !== block.uri;
      return changed ? rewritten as typeof block : block;
    }
    return block;
  });

  let structuredContent = result.structuredContent;
  let structuredChanged = false;
  if (structuredContent !== undefined) {
    const sanitized = sanitizeValue(structuredContent, level);
    structuredChanged = sanitized.changed;
    shapeSafe &&= sanitized.shapeSafe;
    structuredContent = sanitized.value as Record<string, unknown>;
  }
  return { result: { ...result, content, structuredContent }, structuredChanged, shapeSafe, referenceChanged };
}

/** Apply shape-aware output privacy and choose the exact text scanned downstream. */
function sanitizeResultForBoundary(
  result: CallToolResult,
  level: PrivacyLevel,
): { visibleResult: CallToolResult; scanText: string } {
  const originalScanText = callToolResultScanText(result);
  const spans = findPrivacySpans(originalScanText, level);
  const atomicRanges = resultAtomicRanges(result);
  const shapeExpressible = spans.every((span) => shapeExpressibleSpan(span, spans, atomicRanges));
  const shaped = sanitizeCallToolResult(result, level);

  // KEYPOINT-REVIEW: privacy is detected on the original boundary-aware
  // concatenation, not on masked output. Only a match contained entirely in
  // one independently rewritten value can preserve the MCP shape. Matches that
  // cross content parts or structured scalar values require the flat
  // error-shaped fallback. Any structured rewrite uses that fallback too: the
  // proxy does not validate redacted values against the upstream outputSchema,
  // and successful structuredContent would otherwise be rejected for format
  // constraints such as provider-key patterns.
  if (!shaped.shapeSafe || !shapeExpressible || shaped.structuredChanged || shaped.referenceChanged) {
    const scanText = protectText(originalScanText, level);
    return {
      visibleResult: replaceWithSanitizedText(result, scanText),
      scanText,
    };
  }
  return {
    visibleResult: shaped.result,
    scanText: callToolResultScanText(shaped.result),
  };
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
  onProgress?: (progress: Progress) => void,
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

  const privacyApplies = engine.shouldApplyPrivacy(params.name);
  const forwardArguments = privacyApplies
    ? restoreSurrogatesInValue(params.arguments) as Record<string, unknown> | undefined
    : params.arguments;
  const forwardParams = {
    ...params,
    arguments: forwardArguments,
  };
  const upstreamResult = await upstreamClient.callTool(
    forwardParams,
    undefined,
    {
      signal,
      onprogress: onProgress,
      resetTimeoutOnProgress: true,
    },
  ) as CallToolResult;

  const privacy = engine.getPrivacySettings();
  const boundary = privacyApplies
    ? sanitizeResultForBoundary(upstreamResult, privacy.level)
    : { visibleResult: upstreamResult, scanText: callToolResultScanText(upstreamResult) };
  const after = await engine.processHook({
    hookPoint: "after",
    toolName: params.name,
    content: boundary.scanText,
    toolArgs: forwardParams.arguments,
    toolResult: upstreamResult,
    privacyHandled: true,
  });
  const visibleResult = boundary.visibleResult;

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
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const progressToken = request.params._meta?.progressToken;
    const onProgress = progressToken === undefined
      ? undefined
      : (progress: Progress) => {
        // Progress messages are arbitrary upstream text delivered before the
        // final output scan. Relay only numeric progress so the proxy never
        // exposes unscanned instructions or secrets it cannot retract later.
        void extra.sendNotification({
          method: "notifications/progress",
          params: {
            progress: progress.progress,
            total: progress.total,
            progressToken,
          },
        }).catch(() => {
          // Progress is best-effort; the tool result is the enforcement boundary.
        });
      };
    return scanMcpToolCall(upstreamClient, engine, request.params, extra.signal, onProgress);
  });
  return server;
}
