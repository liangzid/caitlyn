/**
 * CAITLYN Session Manager
 *
 * JSONL session persistence with tree (branching) support.
 * Ported from pi coding agent's SessionManager pattern.
 *
 * Directory: ~/.caitlyn/sessions/<cwd-encoded>/<session-id>.jsonl
 * Format: JSONL (append-only, one JSON object per line)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type {
  SessionEntry,
  SessionEntryBase,
  SessionTreeNode,
  SessionInfo,
  SessionContext,
  MessageEntry,
  ModelChangeEntry,
  ThinkingLevelChangeEntry,
  CompactionEntry,
  BranchSummaryEntry,
  LabelEntry,
  SessionInfoEntry,
  CustomEntry,
} from "./session-types.js";

// ── Helpers ───────────────────────────────────────────────────────

function encodeCwd(cwd: string): string {
  // Encode % first, then /, so decoding is unambiguous
  return cwd.replace(/%/g, "%25").replace(/\//g, "%2F");
}

function sessionDir(cwd: string): string {
  return path.join(os.homedir(), ".caitlyn", "sessions", encodeCwd(cwd));
}

function makeSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const uuid = randomUUID().slice(0, 8);
  return `${ts}_${uuid}`;
}

function entryToLine(entry: SessionEntry): string {
  return JSON.stringify(entry) + "\n";
}

function parseEntry(raw: Record<string, unknown>): SessionEntry {
  // Basic validation: ensure type field exists
  if (typeof raw.type !== "string") {
    throw new Error(`Invalid session entry: missing type field`);
  }
  return raw as unknown as SessionEntry;
}

// ── SessionManager ────────────────────────────────────────────────

export class SessionManager {
  private entries: SessionEntry[] = [];
  private leafId: string | null = null;
  private dirty = false;
  private filePath: string;
  private sessionId: string;
  private cwd: string;

  private constructor(
    filePath: string,
    sessionId: string,
    cwd: string,
    entries?: SessionEntry[],
  ) {
    this.filePath = filePath;
    this.sessionId = sessionId;
    this.cwd = cwd;
    if (entries) {
      this.entries = entries;
      this.leafId = entries.length > 0 ? entries[entries.length - 1].id : null;
    }
  }

  // ── Factory Methods ────────────────────────────────────────

  /** Create a brand-new session for the given cwd. */
  static create(cwd: string, sessionDirPath?: string): SessionManager {
    const dir = sessionDirPath ?? sessionDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const id = makeSessionId();
    const fp = path.join(dir, `${id}.jsonl`);
    // Create empty file
    fs.writeFileSync(fp, "", "utf-8");
    return new SessionManager(fp, id, cwd);
  }

  /** Continue the most recent session for the cwd, or create a new one. */
  static continueRecent(cwd: string, sessionDirPath?: string): SessionManager {
    const dir = sessionDirPath ?? sessionDir(cwd);
    if (!fs.existsSync(dir)) return SessionManager.create(cwd, sessionDirPath);

    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        return { name: f, path: fp, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return SessionManager.create(cwd, sessionDirPath);

    return SessionManager.open(files[0].path, cwd);
  }

  /** Open an existing session file. */
  static open(filePath: string, cwdOverride?: string): SessionManager {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Session file not found: ${filePath}`);
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const entries: SessionEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(parseEntry(JSON.parse(line)));
      } catch {
        console.warn(`Skipping malformed session entry: ${line.slice(0, 80)}`);
      }
    }
    const cwd = cwdOverride ?? entries.find((e) => "cwd" in e && typeof (e as any).cwd === "string")
      ? (entries.find((e) => "cwd" in e && typeof (e as any).cwd === "string") as any)?.cwd ?? process.cwd()
      : process.cwd();
    const basename = path.basename(filePath);
    const idMatch = basename.match(/^([A-Z0-9]+_.+)\.jsonl$/i);
    const rawId = idMatch ? idMatch[1] : (() => { console.warn(`Session filename does not match expected pattern: ${basename}`); return makeSessionId(); })();

    return new SessionManager(filePath, rawId, cwd, entries);
  }

  /** Create an in-memory session (not persisted to disk). */
  static inMemory(cwd?: string): SessionManager {
    return new SessionManager(":memory:", makeSessionId(), cwd ?? process.cwd());
  }

  /** Fork a session from a source file into a new cwd. */
  static forkFrom(sourcePath: string, targetCwd: string): SessionManager {
    const source = SessionManager.open(sourcePath);
    const forked = SessionManager.create(targetCwd);
    // Copy all entries with deep clone
    for (const entry of source.entries) {
      forked.entries.push(structuredClone(entry));
    }
    forked.leafId = source.leafId;
    forked.flush();
    return forked;
  }

  /** List all sessions for a cwd. */
  static list(cwd: string, limit = 50): SessionInfo[] {
    const dir = sessionDir(cwd);
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, path: path.join(dir, f) }))
      .map((f) => ({ ...f, stat: fs.statSync(f.path) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, limit);

    return files.map((f): SessionInfo => {
      const raw = fs.readFileSync(f.path, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      const entries = lines.map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean) as SessionEntry[];

      let name: string | undefined;
      let totalInput = 0;
      let totalOutput = 0;
      let totalCost = 0;

      for (const e of entries) {
        if (e.type === "session_info") name = (e as SessionInfoEntry).name;
        if (e.type === "message" && (e as MessageEntry).usage) {
          totalInput += (e as MessageEntry).usage!.input;
          totalOutput += (e as MessageEntry).usage!.output;
          totalCost += (e as MessageEntry).usage!.cost ?? 0;
        }
      }

      return {
        path: f.path,
        id: path.basename(f.name, ".jsonl"),
        cwd,
        entryCount: entries.length,
        name,
        createdAt: f.stat.birthtimeMs,
        updatedAt: f.stat.mtimeMs,
        totalTokens: { input: totalInput, output: totalOutput },
        totalCost,
      };
    });
  }

  /** List all sessions across all cwds. */
  static listAll(): SessionInfo[] {
    const base = path.join(os.homedir(), ".caitlyn", "sessions");
    if (!fs.existsSync(base)) return [];

    const results: SessionInfo[] = [];
    for (const dirName of fs.readdirSync(base)) {
      const dirPath = path.join(base, dirName);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      // Decode cwd: reverse the %2F/%25 encoding
      const cwdDecoded = dirName.replace(/%2F/g, "/").replace(/%25/g, "%");
      results.push(...SessionManager.list(cwdDecoded));
    }
    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ── Append Methods ──────────────────────────────────────────

  private append(entry: Record<string, unknown>): string {
    const full: SessionEntry = {
      ...entry,
      id: randomUUID(),
      parentId: this.leafId,
      timestamp: Date.now(),
    } as unknown as SessionEntry;

    this.entries.push(full);
    this.leafId = full.id;
    this.dirty = true;
    return full.id;
  }

  appendMessage(msg: {
    role: "user" | "assistant" | "system";
    content: string;
    usage?: MessageEntry["usage"];
  }): string {
    return this.append({
      type: "message",
      ...msg,
    });
  }

  appendModelChange(provider: string, modelId: string): string {
    return this.append({
      type: "model_change",
      provider,
      modelId,
    });
  }

  appendThinkingLevelChange(level: ThinkingLevelChangeEntry["level"]): string {
    return this.append({ type: "thinking_level_change", level });
  }

  appendCompaction(
    summary: string,
    firstKeptId: string,
    tokensBefore: number,
  ): string {
    return this.append({
      type: "compaction",
      summary,
      firstKeptEntryId: firstKeptId,
      tokensBefore,
    });
  }

  appendBranchSummary(fromId: string, summary: string): string {
    return this.append({ type: "branch_summary", fromId, summary });
  }

  appendLabel(targetId: string, label: string): string {
    return this.append({ type: "label", targetId, label });
  }

  appendSessionInfo(name: string): string {
    return this.append({ type: "session_info", name });
  }

  appendCustom(namespace: string, data: unknown): string {
    return this.append({ type: "custom", namespace, data });
  }

  // ── Tree Navigation ─────────────────────────────────────────

  getLeafId(): string | null {
    return this.leafId;
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.entries.find((e) => e.id === this.leafId);
  }

  getChildren(parentId: string): SessionEntry[] {
    return this.entries.filter((e) => e.parentId === parentId);
  }

  /** Get the branch from a given entry to the root (leaf → root). */
  getBranch(fromId?: string): SessionEntry[] {
    const startId = fromId ?? this.leafId;
    if (!startId) return [];

    const entryMap = new Map(this.entries.map((e) => [e.id, e]));
    const branch: SessionEntry[] = [];
    let current: SessionEntry | undefined = entryMap.get(startId);
    while (current) {
      branch.push(current);
      current = current.parentId ? entryMap.get(current.parentId) : undefined;
    }
    return branch;
  }

  /** Get the full tree structure. */
  getTree(): SessionTreeNode[] {
    const childrenMap = new Map<string | null, SessionEntry[]>();
    for (const e of this.entries) {
      const pid = e.parentId ?? "__root__";
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid)!.push(e);
    }

    function buildTree(pid: string | null): SessionTreeNode[] {
      const key = pid ?? "__root__";
      const children = childrenMap.get(key) ?? [];
      return children.map((e) => ({
        entry: e,
        children: buildTree(e.id),
      }));
    }

    return buildTree(null);
  }

  getAllEntries(): SessionEntry[] {
    return this.entries;
  }

  getSessionName(): string | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].type === "session_info") {
        return (this.entries[i] as SessionInfoEntry).name;
      }
    }
    return undefined;
  }

  /** Build the LLM context from entries, respecting compaction boundaries. */
  buildSessionContext(): SessionContext {
    // Find the most recent compaction (-1 means none found)
    let compactFromIndex = -1;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].type === "compaction") {
        compactFromIndex = i;
        break;
      }
    }

    const messages: SessionContext["messages"] = [];
    let firstIncludedEntryId: string | null = null;

    // If compaction was applied, add summary as system message
    const compaction = compactFromIndex >= 0
      ? (this.entries[compactFromIndex] as CompactionEntry)
      : null;

    if (compaction) {
      messages.push({
        role: "system",
        content: `[Previous conversation summarized]: ${compaction.summary}`,
      });
    }

    for (let i = compactFromIndex + 1; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.type === "message") {
        const msg = e as MessageEntry;
        if (!firstIncludedEntryId) firstIncludedEntryId = msg.id;
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    return { messages, firstIncludedEntryId };
  }

  // ── Navigation ──────────────────────────────────────────────

  /** Move the leaf pointer to a specific entry (branch navigation). */
  branch(branchFromId: string): void {
    const entry = this.entries.find((e) => e.id === branchFromId);
    if (!entry) throw new Error(`Entry ${branchFromId} not found`);
    this.leafId = branchFromId;
  }

  /** Reset leaf pointer to the root (first entry). */
  resetLeaf(): void {
    this.leafId = this.entries.length > 0 ? this.entries[0].id : null;
  }

  createBranchedSession(targetLeafId: string): string {
    const branch = this.getBranch(targetLeafId);
    // Reverse to get root → leaf order
    branch.reverse();

    const newMgr = SessionManager.create(this.cwd);
    // Build an old→new ID map so parentIds stay consistent
    const idMap = new Map<string, string>();
    for (const entry of branch) {
      const newId = randomUUID();
      idMap.set(entry.id, newId);
      const cloned = structuredClone(entry);
      cloned.id = newId;
      cloned.parentId = entry.parentId ? (idMap.get(entry.parentId) ?? null) : null;
      newMgr.entries.push(cloned);
    }
    newMgr.leafId = idMap.get(targetLeafId) ?? targetLeafId;
    newMgr.flush();
    return newMgr.getSessionFile();
  }

  // ── Accessors ───────────────────────────────────────────────

  getCwd(): string { return this.cwd; }
  getSessionDir(): string { return path.dirname(this.filePath); }
  getSessionId(): string { return this.sessionId; }
  getSessionFile(): string { return this.filePath; }
  getEntryCount(): number { return this.entries.length; }

  /** Total cumulative token counts across all messages. */
  getTokenStats(): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;

    for (const e of this.entries) {
      if (e.type === "message" && (e as MessageEntry).usage) {
        const u = (e as MessageEntry).usage!;
        input += u.input;
        output += u.output;
        cacheRead += u.cacheRead ?? 0;
        cacheWrite += u.cacheWrite ?? 0;
        cost += u.cost ?? 0;
      }
    }

    return { input, output, cacheRead, cacheWrite, cost };
  }

  // ── Persistence ─────────────────────────────────────────────

  /** Flush pending entries to disk atomically (tmp file + rename). */
  flush(): void {
    if (!this.dirty || this.filePath === ":memory:") return;
    const lines: string[] = [];
    for (const e of this.entries) {
      lines.push(entryToLine(e));
    }
    const tmpPath = this.filePath + ".tmp";
    fs.writeFileSync(tmpPath, lines.join(""), "utf-8");
    fs.renameSync(tmpPath, this.filePath);
    this.dirty = false;
  }

  /** Delete the session file from disk. */
  delete(): void {
    if (this.filePath !== ":memory:" && fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
    this.entries = [];
    this.leafId = null;
  }
}
