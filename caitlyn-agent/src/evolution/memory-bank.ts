/**
 * CAITLYN Evolution — Memory Bank
 *
 * Fast-path attack signature matching using exact strings and
 * compiled regex patterns. Persisted to JSONL for crash recovery.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryEntry, MemoryMatch } from "./types.js";

const MEMORY_PATH = path.join(
  path.resolve(import.meta.dirname!, "../../.."),
  "memory_bank.jsonl",
);

export class MemoryBank {
  private entries = new Map<string, MemoryEntry>();
  private regexPatterns: Array<{ id: string; regex: RegExp }> = [];

  /** Load persisted entries from JSONL on startup. */
  load(): void {
    try {
      if (!fs.existsSync(MEMORY_PATH)) return;
      const raw = fs.readFileSync(MEMORY_PATH, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as MemoryEntry;
          this.entries.set(entry.id, entry);
          if (entry.signatureType === "regex") {
            try {
              this.regexPatterns.push({ id: entry.id, regex: new RegExp(entry.pattern, "i") });
            } catch { /* skip invalid regex */ }
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* file missing or corrupt — start fresh */ }
  }

  /** Check content against all memory entries. Returns first match. */
  check(content: string): MemoryMatch {
    for (const entry of this.entries.values()) {
      if (entry.signatureType === "exact" && content.includes(entry.pattern)) {
        this.recordHit(entry.id);
        return { kind: "exact", entry };
      }
    }
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

  /** Add a memory entry and persist to JSONL. */
  add(entry: MemoryEntry): void {
    this.entries.set(entry.id, entry);
    if (entry.signatureType === "regex") {
      try {
        this.regexPatterns.push({ id: entry.id, regex: new RegExp(entry.pattern, "i") });
      } catch { /* skip invalid regex */ }
    }
    // Persist: append one JSON line
    try {
      fs.appendFileSync(MEMORY_PATH, JSON.stringify(entry) + "\n", "utf-8");
    } catch { /* disk full or permission — memory-only fallback */ }
  }

  remove(id: string): void {
    this.entries.delete(id);
    this.regexPatterns = this.regexPatterns.filter((r) => r.id !== id);
  }

  list(): MemoryEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  private recordHit(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.hitCount++;
  }

  prune(maxEntries: number): void {
    if (this.entries.size <= maxEntries) return;
    const sorted = [...this.entries.values()].sort((a, b) => b.hitCount - a.hitCount);
    const toKeep = new Set(sorted.slice(0, maxEntries).map((e) => e.id));
    for (const id of this.entries.keys()) {
      if (!toKeep.has(id)) this.remove(id);
    }
  }
}
