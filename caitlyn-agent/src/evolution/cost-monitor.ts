/**
 * CAITLYN Evolution — Cost Monitor
 *
 * Tracks defense cost per attack pattern. Triggers vaccination
 * when cumulative latency or token cost exceeds thresholds.
 * Mirrors src/surveillance/cost_monitor.rs.
 */
import { createHash } from "node:crypto";
import type { CostRecord, VaccinationTriggerConfig } from "./types.js";

export class CostMonitor {
  private records = new Map<string, CostRecord>();
  private config: VaccinationTriggerConfig;

  constructor(config: VaccinationTriggerConfig) {
    this.config = config;
  }

  /** Normalize content and compute SHA256 pattern hash. */
  computePatternHash(content: string): string {
    const normalized = content.slice(0, 500).replace(/\s+/g, " ").trim().toLowerCase();
    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  /** Record a scan against a pattern. */
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
    return record;
  }

  /** Get a cost record by pattern hash. */
  get(patternHash: string): CostRecord | undefined {
    return this.records.get(patternHash);
  }

  /** Check if a pattern should trigger vaccination. */
  shouldVaccinate(record: CostRecord): boolean {
    if (record.vaccinated) return false;
    if (record.callCount < this.config.minSamples) return false;

    const successRate = record.callCount > 0
      ? record.successCount / record.callCount
      : 0;
    if (successRate < this.config.minSuccessRate) return false;

    const avgLatency = record.totalLatencyUs / record.callCount;
    const avgTokens = record.totalTokens / record.callCount;
    return avgLatency > this.config.latencyThresholdUs || avgTokens > this.config.tokenThreshold;
  }

  /** Mark a pattern as vaccinated. */
  markVaccinated(patternHash: string, antibodyId: string): void {
    const record = this.records.get(patternHash);
    if (record) {
      record.vaccinated = true;
      record.vaccineAntibodyId = antibodyId;
    }
  }

  /** Get all tracked patterns. */
  list(): CostRecord[] {
    return [...this.records.values()];
  }

  /** Number of tracked patterns. */
  get patternCount(): number {
    return this.records.size;
  }
}
