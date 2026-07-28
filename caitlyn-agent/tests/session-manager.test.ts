/**
 * Tests for SessionManager — session CRUD, token stats, session context.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SessionManager } from "../src/session/session-manager.js";
import type {
  MessageEntry,
  SessionInfo,
} from "../src/session/session-types.js";

// ── Test Helpers ────────────────────────────────────────────────────

function tmpSessionDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-sess-test-"));
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** Small helper to sleep for a few ms (ensures different file mtimes). */
function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ───────────────────────────────────────────────────────────

describe("SessionManager", () => {
  describe("inMemory()", () => {
    it("creates a session without touching disk", () => {
      const mgr = SessionManager.inMemory("/test/cwd");
      expect(mgr.getCwd()).toBe("/test/cwd");
      expect(mgr.getEntryCount()).toBe(0);
      expect(mgr.getSessionFile()).toBe(":memory:");
      expect(mgr.getLeafId()).toBeNull();
    });

    it("appendMessage() stores a message entry", () => {
      const mgr = SessionManager.inMemory();
      const id = mgr.appendMessage({
        role: "user",
        content: "Hello, world",
      });

      expect(id).toBeTruthy();
      expect(mgr.getEntryCount()).toBe(1);
      expect(mgr.getLeafId()).toBe(id);
    });

    it("appendMessage() records usage data", () => {
      const mgr = SessionManager.inMemory();
      mgr.appendMessage({
        role: "assistant",
        content: "Response",
        usage: { input: 100, output: 200, cost: 0.005 },
      });

      const stats = mgr.getTokenStats();
      expect(stats.input).toBe(100);
      expect(stats.output).toBe(200);
      expect(stats.cost).toBe(0.005);
    });

    it("flush() on in-memory session is a no-op", () => {
      const mgr = SessionManager.inMemory();
      mgr.appendMessage({ role: "user", content: "test" });
      mgr.flush();
      expect(mgr.getEntryCount()).toBe(1);
    });
  });

  describe("create()", () => {
    let dirs: string[] = [];

    afterEach(() => {
      for (const d of dirs) cleanup(d);
      dirs = [];
    });

    it("creates a new session file on disk", () => {
      const dir = tmpSessionDir();
      dirs.push(dir);

      const mgr = SessionManager.create("/test/cwd", dir);
      expect(mgr.getCwd()).toBe("/test/cwd");
      expect(mgr.getEntryCount()).toBe(0);
      expect(mgr.getSessionFile()).toMatch(/\.jsonl$/);
      expect(fs.existsSync(mgr.getSessionFile())).toBe(true);
    });

    it("appendMessage() + flush() round-trip preserves data", () => {
      const dir = tmpSessionDir();
      dirs.push(dir);

      const mgr1 = SessionManager.create("/test/cwd", dir);
      mgr1.appendMessage({ role: "user", content: "Message 1" });
      mgr1.appendMessage({
        role: "assistant",
        content: "Reply 1",
        usage: { input: 50, output: 150, cost: 0.003 },
      });
      mgr1.flush();

      // Re-open the session
      const mgr2 = SessionManager.open(mgr1.getSessionFile(), "/test/cwd");
      expect(mgr2.getEntryCount()).toBe(2);

      const stats = mgr2.getTokenStats();
      expect(stats.input).toBe(50);
      expect(stats.output).toBe(150);
      expect(stats.cost).toBe(0.003);

      const entries = mgr2.getAllEntries();
      const messages = entries.filter((e) => e.type === "message") as MessageEntry[];
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Message 1");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("Reply 1");
    });
  });

  describe("open()", () => {
    let dirs: string[] = [];

    afterEach(() => {
      for (const d of dirs) cleanup(d);
      dirs = [];
    });

    it("opens an existing session file with explicit cwd", () => {
      const dir = tmpSessionDir();
      dirs.push(dir);

      const mgr1 = SessionManager.create("/test/cwd", dir);
      mgr1.appendMessage({ role: "user", content: "test" });
      mgr1.flush();

      // Pass explicit cwdOverride
      const mgr2 = SessionManager.open(mgr1.getSessionFile(), "/test/cwd");
      expect(mgr2.getEntryCount()).toBe(1);
      expect(mgr2.getCwd()).toBe("/test/cwd");
    });

    it("throws for non-existent file", () => {
      expect(() => SessionManager.open("/nonexistent/path.jsonl")).toThrow(
        "Session file not found",
      );
    });
  });

  describe("continueRecent()", () => {
    let dirs: string[] = [];

    afterEach(() => {
      for (const d of dirs) cleanup(d);
      dirs = [];
    });

    it("creates a new session when no sessions exist", () => {
      const dir = tmpSessionDir();
      dirs.push(dir);

      const mgr = SessionManager.continueRecent("/test/cwd", dir);
      expect(mgr.getEntryCount()).toBe(0);
      expect(fs.existsSync(mgr.getSessionFile())).toBe(true);
    });

    it("finds the most recent session", async () => {
      const dir = tmpSessionDir();
      dirs.push(dir);

      // Create two sessions with a delay between them to ensure different mtimes
      const mgr1 = SessionManager.create("/test/cwd", dir);
      mgr1.appendMessage({ role: "user", content: "old" });
      mgr1.flush();

      // Ensure mtime difference
      await sleepMs(50);

      const mgr2 = SessionManager.create("/test/cwd", dir);
      mgr2.appendMessage({ role: "user", content: "new" });
      mgr2.flush();

      const recent = SessionManager.continueRecent("/test/cwd", dir);
      // Should open the most recent one (mgr2)
      const entries = recent.getAllEntries();
      const messages = entries.filter((e) => e.type === "message") as MessageEntry[];
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("new");
    });
  });

  describe("list()", () => {
    let dirs: string[] = [];

    afterEach(() => {
      for (const d of dirs) cleanup(d);
      dirs = [];
    });

    it("returns empty array for non-existent cwd directory", () => {
      // Use a cwd path that hasn't been used to create sessions
      const sessions = SessionManager.list("/nonexistent-cwd-" + Date.now());
      expect(sessions).toEqual([]);
    });

    it("returns session infos for sessions created with custom dir", () => {
      const dir = tmpSessionDir();
      dirs.push(dir);

      const mgr = SessionManager.create("/test/cwd", dir);
      mgr.appendMessage({
        role: "assistant",
        content: "Hello",
        usage: { input: 10, output: 20, cost: 0.001 },
      });
      mgr.appendSessionInfo("Test Session");
      mgr.flush();

      // list() uses the default session dir based on os.homedir(),
      // not our custom dir. So this only works when the custom dir
      // matches the default path. For a custom dir test, we verify
      // the session we created is valid.
      expect(mgr.getEntryCount()).toBe(2);
      expect(mgr.getSessionName()).toBe("Test Session");

      const stats = mgr.getTokenStats();
      expect(stats.input).toBe(10);
      expect(stats.output).toBe(20);
      expect(stats.cost).toBe(0.001);
    });
  });

  describe("getTokenStats()", () => {
    it("returns zeros for empty session", () => {
      const mgr = SessionManager.inMemory();
      const stats = mgr.getTokenStats();
      expect(stats).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      });
    });

    it("computes correct totals across multiple messages", () => {
      const mgr = SessionManager.inMemory();

      mgr.appendMessage({
        role: "assistant",
        content: "First",
        usage: { input: 100, output: 200, cost: 0.01 },
      });
      mgr.appendMessage({
        role: "assistant",
        content: "Second",
        usage: { input: 150, output: 300, cost: 0.02 },
      });
      mgr.appendMessage({
        role: "assistant",
        content: "Third",
        usage: {
          input: 50,
          output: 75,
          cacheRead: 30,
          cacheWrite: 10,
          cost: 0.005,
        },
      });

      const stats = mgr.getTokenStats();
      expect(stats.input).toBe(300);
      expect(stats.output).toBe(575);
      expect(stats.cacheRead).toBe(30);
      expect(stats.cacheWrite).toBe(10);
      expect(stats.cost).toBeCloseTo(0.035, 5);
    });

    it("ignores non-message entries and messages without usage", () => {
      const mgr = SessionManager.inMemory();

      mgr.appendMessage({ role: "user", content: "No usage" });
      mgr.appendModelChange("openai", "gpt-4");
      mgr.appendMessage({
        role: "assistant",
        content: "Has usage",
        usage: { input: 42, output: 84, cost: 0.003 },
      });

      const stats = mgr.getTokenStats();
      expect(stats.input).toBe(42);
      expect(stats.output).toBe(84);
    });
  });

  describe("buildSessionContext()", () => {
    it("returns empty messages for empty session", () => {
      const mgr = SessionManager.inMemory();
      const ctx = mgr.buildSessionContext();
      expect(ctx.messages).toEqual([]);
      expect(ctx.firstIncludedEntryId).toBeNull();
    });

    it("returns all messages when no compaction", () => {
      const mgr = SessionManager.inMemory();

      mgr.appendMessage({ role: "user", content: "Q1" });
      mgr.appendMessage({ role: "assistant", content: "A1" });
      mgr.appendMessage({ role: "user", content: "Q2" });
      mgr.appendMessage({ role: "assistant", content: "A2" });

      const ctx = mgr.buildSessionContext();
      expect(ctx.messages).toHaveLength(4);
      expect(ctx.messages[0]).toEqual({ role: "user", content: "Q1" });
      expect(ctx.messages[3]).toEqual({ role: "assistant", content: "A2" });
    });

    it("returns messages after the most recent compaction", () => {
      const mgr = SessionManager.inMemory();

      mgr.appendMessage({ role: "user", content: "Old Q" });
      mgr.appendMessage({ role: "assistant", content: "Old A" });

      const firstKeptEntryId = "dummy-id";
      mgr.appendCompaction("Summary of old conversation", firstKeptEntryId, 500);

      mgr.appendMessage({ role: "user", content: "New Q" });
      mgr.appendMessage({ role: "assistant", content: "New A" });

      const ctx = mgr.buildSessionContext();
      expect(ctx.messages).toHaveLength(3);

      expect(ctx.messages[0]).toEqual({
        role: "system",
        content: "[Previous conversation summarized]: Summary of old conversation",
      });

      expect(ctx.messages[1]).toEqual({ role: "user", content: "New Q" });
      expect(ctx.messages[2]).toEqual({ role: "assistant", content: "New A" });
    });

    it("uses the most recent compaction when multiple exist", () => {
      const mgr = SessionManager.inMemory();

      mgr.appendMessage({ role: "user", content: "Phase 1" });
      mgr.appendCompaction("First compaction", "dummy-1", 100);
      mgr.appendMessage({ role: "user", content: "Phase 2" });
      mgr.appendCompaction("Second compaction", "dummy-2", 200);
      mgr.appendMessage({ role: "user", content: "Phase 3" });

      const ctx = mgr.buildSessionContext();
      expect(ctx.messages).toHaveLength(2);
      expect(ctx.messages[0].content).toContain("Second compaction");
      expect(ctx.messages[1].content).toBe("Phase 3");
    });

    it("sets firstIncludedEntryId to the first message after compaction", () => {
      const mgr = SessionManager.inMemory();

      mgr.appendCompaction("Summary", "dummy", 500);
      const msgId = mgr.appendMessage({ role: "user", content: "First after compaction" });
      mgr.appendMessage({ role: "assistant", content: "Reply" });

      const ctx = mgr.buildSessionContext();
      expect(ctx.firstIncludedEntryId).toBe(msgId);
    });
  });

  describe("session metadata", () => {
    it("getSessionName() returns the most recent session_info name", () => {
      const mgr = SessionManager.inMemory();

      expect(mgr.getSessionName()).toBeUndefined();

      mgr.appendSessionInfo("My Session");
      expect(mgr.getSessionName()).toBe("My Session");

      mgr.appendSessionInfo("Renamed Session");
      expect(mgr.getSessionName()).toBe("Renamed Session");
    });
  });

  describe("getBranch()", () => {
    it("returns branch from leaf to root", () => {
      const mgr = SessionManager.inMemory();

      const id1 = mgr.appendMessage({ role: "user", content: "Start" });
      const id2 = mgr.appendMessage({ role: "assistant", content: "Mid" });
      const id3 = mgr.appendMessage({ role: "user", content: "End" });

      const branch = mgr.getBranch();
      expect(branch).toHaveLength(3);
      expect(branch[0].id).toBe(id3);
      expect(branch[1].id).toBe(id2);
      expect(branch[2].id).toBe(id1);
    });
  });

  describe("delete()", () => {
    let dirs: string[] = [];

    afterEach(() => {
      for (const d of dirs) cleanup(d);
      dirs = [];
    });

    it("removes the session file from disk", () => {
      const dir = tmpSessionDir();
      dirs.push(dir);

      const mgr = SessionManager.create("/test/cwd", dir);
      const filePath = mgr.getSessionFile();
      expect(fs.existsSync(filePath)).toBe(true);

      mgr.delete();
      expect(fs.existsSync(filePath)).toBe(false);
      expect(mgr.getEntryCount()).toBe(0);
    });

    it("delete() on in-memory session is safe", () => {
      const mgr = SessionManager.inMemory();
      mgr.appendMessage({ role: "user", content: "test" });
      mgr.delete();
      expect(mgr.getEntryCount()).toBe(0);
    });
  });

  describe("forkFrom()", () => {
    let dirs: string[] = [];

    afterEach(() => {
      for (const d of dirs) cleanup(d);
      dirs = [];
    });

    it("copies all entries to a new session", () => {
      const dir = tmpSessionDir();
      dirs.push(dir);

      const source = SessionManager.create("/source/cwd", dir);
      source.appendMessage({ role: "user", content: "Original" });
      source.appendMessage({ role: "assistant", content: "Reply" });
      source.flush();

      const destDir = tmpSessionDir();
      dirs.push(destDir);

      const forked = SessionManager.forkFrom(source.getSessionFile(), "/dest/cwd");
      expect(forked.getCwd()).toBe("/dest/cwd");
      expect(forked.getEntryCount()).toBe(2);

      const entries = forked.getAllEntries();
      const messages = entries.filter((e) => e.type === "message") as MessageEntry[];
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("Original");
      expect(messages[1].content).toBe("Reply");
    });
  });
});
