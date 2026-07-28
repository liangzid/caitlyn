/**
 * CAITLYN Evolution — Cost Monitor
 *
 * Tracks defense cost per attack pattern. Triggers vaccination
 * when cumulative latency or token cost exceeds thresholds.
 * Persisted to JSONL for crash recovery.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CostRecord, VaccinationTriggerConfig } from "./types.js";

const COST_PATH = path.join(
  path.resolve(import.meta.dirname!, "../../.."),
  "cost_log.jsonl",
);

export class CostMonitor {
  private records = new Map<string, CostRecord>();
  private config: VaccinationTriggerConfig;

  constructor(config: VaccinationTriggerConfig) {
    this.config = config;
  }

  /** Load persisted records from JSONL on startup. */
  load(): void {
    try {
      if (!fs.existsSync(COST_PATH)) return;
      const raw = fs.readFileSync(COST_PATH, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as CostRecord;
          this.records.set(record.patternHash, record);
        } catch { /* skip malformed */ }
      }
    } catch { /* file missing or corrupt — start fresh */ }
  }

  computePatternHash(content: string): string {
    const normalized = content.slice(0, 500).replace(/\s+/g, " ").trim().toLowerCase();
    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  record(
    content: string,
    category: string,
    resolvedBy: string[],
    latencyUs: number,
    tokens: number,
    success: boolean,
  ): CostRecord {
    const hash = this.computePatternHash(content);
    const existing = this.records.get(hash);

    if (existing) {
      existing.callCount++;
      existing.totalLatencyUs += latencyUs;
      existing.totalTokens += tokens;
      if (success) existing.successCount++;
      else existing.failureCount++;
      existing.lastSeen = new Date().toISOString();
      existing.resolvedBy = [...new Set([...existing.resolvedBy, ...resolvedBy])];
      return existing;
    }

    const record: CostRecord = {
      patternHash: hash,
      sample: content.slice(0, 200),
      category,
      resolvedBy,
      callCount: 1,
      totalLatencyUs: latencyUs,
      totalTokens: tokens,
      successCount: success ? 1 : 0,
      failureCount: success ? 0 : 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      vaccinated: false,
      vaccineAntibodyId: null,
    };
    this.records.set(hash, record);

    // Persist: append one JSON line
    try {
      fs.appendFileSync(COST_PATH, JSON.stringify(record) + "\n", "utf-8");
    } catch { /* disk full — memory-only fallback */ }

    return record;
  }

  get(patternHash: string): CostRecord | undefined {
    return this.records.get(patternHash);
  }

  shouldVaccinate(record: CostRecord): boolean {
    if (record.vaccinated) return false;
    if (record.callCount < this.config.minSamples) return false;
    const successRate = record.callCount > 0 ? record.successCount / record.callCount : 0;
    if (successRate < this.config.minSuccessRate) return false;
    const avgLatency = record.totalLatencyUs / record.callCount;
    const avgTokens = record.totalTokens / record.callCount;
    return avgLatency > this.config.latencyThresholdUs || avgTokens > this.config.tokenThreshold;
  }

  markVaccinated(patternHash: string, antibodyId: string): void {
    const record = this.records.get(patternHash);
    if (record) {
      record.vaccinated = true;
      record.vaccineAntibodyId = antibodyId;
    }
  }

  list(): CostRecord[] {
    return [...this.records.values()];
  }

  get patternCount(): number {
    return this.records.size;
  }
}
