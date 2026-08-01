/**
 * CAITLYN Evolution — Stats Event Producers
 *
 * Stateless append helper used by scanning, file watching, and hook
 * pipelines. Events land in ~/.caitlyn/stats/events.jsonl and are
 * aggregated by the daemon-side StatsCollector.
 */

import * as os from "node:os";
import * as path from "node:path";
import { StatsCollector, type StatsEventSource } from "./stats-collector.js";

const DEFAULT_STATS_DIR = path.join(os.homedir(), ".caitlyn", "stats");

/** Append one observation; never throws (stats must not break scanning). */
export function appendStatsEvent(
  source: StatsEventSource,
  metric: string,
  value: number,
  meta?: Record<string, unknown>,
): void {
  try {
    const collector = new StatsCollector(DEFAULT_STATS_DIR);
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
