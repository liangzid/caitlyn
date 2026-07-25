/**
 * CAITLYN Session Types
 *
 * JSONL entry types for session persistence. Every state change is an
 * append-only entry forming a DAG (parentId → branching).
 *
 * Architecture:
 *   - id: unique per entry (crypto.randomUUID)
 *   - parentId: parent entry (null for root)
 *   - type: discriminator
 *   - timestamp: Date.now() at write time
 */

// ── Entry Type Union ──────────────────────────────────────────────

export type SessionEntry =
  | MessageEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | LabelEntry
  | SessionInfoEntry
  | CustomEntry;

// ── Base ──────────────────────────────────────────────────────────

export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: number;
}

// ── Entry Types ───────────────────────────────────────────────────

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  role: "user" | "assistant" | "system";
  content: string;
  /** Token usage for this turn (assistant messages only) */
  usage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
  };
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  level: "off" | "low" | "medium" | "high";
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name: string;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  /** Extension namespace (not sent to LLM) */
  namespace: string;
  data: unknown;
}

// ── Tree Types ────────────────────────────────────────────────────

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  entryCount: number;
  name?: string;
  createdAt: number;
  updatedAt: number;
  totalTokens?: { input: number; output: number };
  totalCost?: number;
}

export interface SessionContext {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  /** The id of the first entry included (for compaction-aware slicing) */
  firstIncludedEntryId: string | null;
}
