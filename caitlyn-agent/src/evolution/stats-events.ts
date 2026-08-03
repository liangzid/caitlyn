/**
 * CAITLYN Evolution — Stats Event Producers
 *
 * Stateless append helper used by scanning, file watching, and hook
 * pipelines. Events land in ~/.caitlyn/stats/events.jsonl and are
 * aggregated by the daemon-side StatsCollector.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StatsCollector, type StatsEventSource } from "./stats-collector.js";

/** Stats directory; CAITLYN_STATS_DIR overrides the default. */
function statsDir(): string {
  return process.env.CAITLYN_STATS_DIR || path.join(os.homedir(), ".caitlyn", "stats");
}

/** Append one observation; never throws (stats must not break scanning). */
export function appendStatsEvent(
  source: StatsEventSource,
  metric: string,
  value: number,
  meta?: Record<string, unknown>,
): void {
  try {
    const collector = new StatsCollector(statsDir());
    collector.appendEvent({
      source,
      metric,
      value,
      at: new Date().toISOString(),
      meta,
    });
  } catch {
    // Disk issues or permission problems — scanning continues unaffected.
  }
}

/** Append an anomaly trigger record to triggers.jsonl (audit artifact). */
export function appendTriggerRecord(trigger: {
  source: string;
  metric: string;
  value: number;
  baselineEwma: number;
  baselineP99: number;
  at: string;
}, dir: string = statsDir()): void {
  try {
    const file = path.join(dir, "triggers.jsonl");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(trigger)}\n`, "utf-8");
  } catch {
    // Disk issues — the trigger is still visible in the collector state.
  }
}
