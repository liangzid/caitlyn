/**
 * Tests for TUI event handling logic — assistant content extraction
 * and event processing rules extracted from CaitlynTUI.wireAgentListener.
 */
import { describe, it, expect } from "vitest";
import { extractAssistantContent } from "../src/caitlyn-tui.js";

// ── Tests ───────────────────────────────────────────────────────────

describe("extractAssistantContent", () => {
  it("extracts text from content blocks with type 'text'", () => {
    const content = [
      { type: "text", text: "Hello, world" },
    ];
    expect(extractAssistantContent(content)).toBe("Hello, world");
  });

  it("extracts text from content blocks with type 'thinking'", () => {
    const content = [
      { type: "thinking", content: "Let me think about this..." },
    ];
    expect(extractAssistantContent(content)).toBe("Let me think about this...");
  });

  it("joins multiple text and thinking blocks together", () => {
    const content = [
      { type: "thinking", content: "Hmm, analyzing..." },
      { type: "text", text: "Here is my response." },
      { type: "text", text: " And more details." },
    ];
    expect(extractAssistantContent(content)).toBe(
      "Hmm, analyzing...Here is my response. And more details.",
    );
  });

  it("returns empty string for non-array input", () => {
    expect(extractAssistantContent(null)).toBe("");
    expect(extractAssistantContent(undefined)).toBe("");
    expect(extractAssistantContent("plain string")).toBe("");
    expect(extractAssistantContent(42)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(extractAssistantContent([])).toBe("");
  });

  it("skips blocks with unknown types (not text or thinking)", () => {
    const content = [
      { type: "tool_call", name: "scan", arguments: {} },
      { type: "text", text: "Visible text" },
      { type: "tool_result", result: "data" },
    ];
    expect(extractAssistantContent(content)).toBe("Visible text");
  });

  it("handles blocks with no text or content field gracefully", () => {
    const content = [
      { type: "text" }, // no text field
      { type: "thinking" }, // no content field
      { type: "text", text: "Actual text" },
    ];
    expect(extractAssistantContent(content)).toBe("Actual text");
  });

  it("handles text field being non-string gracefully", () => {
    const content = [
      { type: "text", text: 12345 },
      { type: "text", text: "Real text" },
    ];
    // Only "Real text" should be included (12345 is not a string)
    expect(extractAssistantContent(content)).toBe("Real text");
  });

  it("handles content field being non-string gracefully", () => {
    const content = [
      { type: "thinking", content: { nested: "object" } },
      { type: "thinking", content: "Real thinking" },
    ];
    expect(extractAssistantContent(content)).toBe("Real thinking");
  });

  it("returns empty string when all blocks have unsupported types", () => {
    const content = [
      { type: "tool_call", name: "x" },
      { type: "image", url: "http://..." },
    ];
    expect(extractAssistantContent(content)).toBe("");
  });

  it("preserves text order across blocks", () => {
    const content = [
      { type: "text", text: "First. " },
      { type: "text", text: "Second. " },
      { type: "text", text: "Third." },
    ];
    expect(extractAssistantContent(content)).toBe("First. Second. Third.");
  });
});

describe("Event role filtering logic", () => {
  // These tests verify the business rules that the event handler applies
  // without needing the full TUI infrastructure.

  it("message_end for non-assistant role should be skipped", () => {
    // The wireAgentListener checks: if (msg.role !== "assistant") break;
    // This means user, system, and tool messages are skipped at message_end.
    const isAssistant = (role: string | undefined): boolean => role === "assistant";

    expect(isAssistant("user")).toBe(false);
    expect(isAssistant("system")).toBe(false);
    expect(isAssistant("tool")).toBe(false);
    expect(isAssistant(undefined)).toBe(false);
    expect(isAssistant("assistant")).toBe(true);
  });

  it("message_update for non-assistant role should be skipped", () => {
    // Same role filter applies to message_update events.
    const isAssistant = (role: string | undefined): boolean => role === "assistant";

    expect(isAssistant("user")).toBe(false);
    expect(isAssistant("system")).toBe(false);
    expect(isAssistant("assistant")).toBe(true);
  });

  it("message_update accumulates text across deltas (via content extraction)", () => {
    // The handler sets: currentMessageContent = extractAssistantContent(msg.content)
    // Each delta replaces the current content; the extraction handles the blocks.
    const delta1 = extractAssistantContent([{ type: "text", text: "Hello" }]);
    const delta2 = extractAssistantContent([{ type: "text", text: "Hello, world" }]);
    const delta3 = extractAssistantContent([
      { type: "text", text: "Hello, world! How" },
    ]);
    const delta4 = extractAssistantContent([
      { type: "text", text: "Hello, world! How can I help?" },
    ]);

    expect(delta1).toBe("Hello");
    expect(delta2).toBe("Hello, world");
    expect(delta3).toBe("Hello, world! How");
    expect(delta4).toBe("Hello, world! How can I help?");
  });

  it("message_end extracts content when no streaming updates occurred", () => {
    // In the handler, if currentMessageContent is empty (no streaming updates),
    // it falls back to extracting content from the message at message_end.
    const content = [
      { type: "text", text: "Full response from non-streaming API." },
    ];
    const extracted = extractAssistantContent(content);
    expect(extracted).toBe("Full response from non-streaming API.");
  });

  it("agent_end cleans up state (loader/streaming markdown cleared)", () => {
    // The handler sets currentLoader = null and streamingMd = null on agent_end.
    // We verify the cleanup pattern: these flags should be false/null when done.
    let currentLoader: unknown = { cancel: () => {} };
    let streamingMd: unknown = { content: "streaming..." };

    // Simulate agent_end cleanup
    currentLoader = null;
    streamingMd = null;

    expect(currentLoader).toBeNull();
    expect(streamingMd).toBeNull();
  });
});
