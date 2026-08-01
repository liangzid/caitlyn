/**
 * CAITLYN Evolution — OS/Network Signal Probe
 *
 * Reads real connection statistics from /proc/net on Linux. Emits
 * os_network events so the stats collector can build a baseline and
 * trigger on anomalies (e.g. a sudden connection flood). Non-Linux
 * platforms return no metrics (interface stays ready for other sources).
 */

import * as fs from "node:fs";
import type { StatsEvent } from "./stats-collector.js";

export interface ProcNetStats {
  established: number;
  total: number;
}

/**
 * Parse /proc/net/tcp|udp content: one header line, then one line per
 * socket. The connection state is the 4th whitespace-separated field
 * (hex); 01 = ESTABLISHED.
 */
export function parseProcNetTable(text: string): ProcNetStats {
  let total = 0;
  let established = 0;
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[0] === "sl") continue; // header or empty
    total += 1;
    if (fields[3] === "01") established += 1;
  }
  return { established, total };
}

/** Read real /proc/net connection counts (Linux only). */
export function collectNetworkMetrics(): StatsEvent[] {
  const at = new Date().toISOString();
  const metrics: StatsEvent[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6", "/proc/net/udp"]) {
    try {
      const stats = parseProcNetTable(fs.readFileSync(file, "utf-8"));
      metrics.push({
        source: "os_network",
        metric: `${file.replace("/proc/net/", "")}_sockets`,
        value: stats.total,
        at,
        frequency: true,
      });
      metrics.push({
        source: "os_network",
        metric: `${file.replace("/proc/net/", "")}_established`,
        value: stats.established,
        at,
      });
    } catch {
      // File missing (non-Linux) or unreadable — skip this table.
    }
  }
  return metrics;
}
