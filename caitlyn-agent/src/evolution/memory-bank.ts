/**
 * CAITLYN Evolution — Memory Bank
 *
 * Fast-path attack signature matching using exact strings and
 * compiled regex patterns. Mirrors src/core/memory.rs.
 */
import type { MemoryEntry, MemoryMatch } from "./types.js";

export class MemoryBank {
  private entries = new Map<string, MemoryEntry>();
  private regexPatterns: Array<{ id: string; regex: RegExp }> = [];

  /** Check content against all memory entries. Returns first match. */
  check(content: string): MemoryMatch {
    // 1. Exact match (fastest)
    for (const entry of this.entries.values()) {
      if (entry.signatureType === "exact" && content.includes(entry.pattern)) {
        this.recordHit(entry.id);
        return { kind: "exact", entry };
      }
    }

    // 2. Regex match
    for (const { id, regex } of this.regexPatterns) {
      if (regex.test(content)) {
        const entry = this.entries.get(id);
        if (entry) {
          this.recordHit(entry.id);
          return { kind: "exact", entry };
        }
      }
    }

    return { kind: "none" };
  }

  /** Add a memory entry. Compiles regex patterns on insertion. */
  add(entry: MemoryEntry): void {
    this.entries.set(entry.id, entry);
    if (entry.signatureType === "regex") {
      try {
        this.regexPatterns.push({ id: entry.id, regex: new RegExp(entry.pattern, "i") });
      } catch {
        // Invalid regex — skip pattern matching for this entry
      }
    }
  }

  /** Remove a memory entry. */
  remove(id: string): void {
    this.entries.delete(id);
    this.regexPatterns = this.regexPatterns.filter((r) => r.id !== id);
  }

  /** Get all entries. */
  list(): MemoryEntry[] {
    return [...this.entries.values()];
  }

  /** Total entry count. */
  get size(): number {
    return this.entries.size;
  }

  /** Record a hit on a memory entry (increments hit count). */
  private recordHit(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.hitCount++;
  }

  /** Prune entries beyond max, keeping most-hit entries. */
  prune(maxEntries: number): void {
    if (this.entries.size <= maxEntries) return;

    const sorted = [...this.entries.values()]
      .sort((a, b) => b.hitCount - a.hitCount);

    const toKeep = new Set(sorted.slice(0, maxEntries).map((e) => e.id));
    for (const id of this.entries.keys()) {
      if (!toKeep.has(id)) this.remove(id);
    }
  }
}
