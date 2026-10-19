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

/** Read one procfs path. Returns null when missing or unreadable. */
export type ProcNetReader = (path: string) => string | null;

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

/** Default reader: real /proc/net, no invented counts. */
export function readProcNetFile(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Parse `TCP: inuse N` / `UDP: inuse N` lines from /proc/net/sockstat.
 * This is O(1) in the number of sockets, unlike scanning tcp tables.
 */
export function parseSockstatInuse(text: string, proto: string): number | null {
  const prefix = `${proto}:`;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const match = /\binuse\s+(\d+)/.exec(trimmed);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function sockstatEvents(
  reader: ProcNetReader,
  file: string,
  at: string,
  suffixes: Array<{ proto: string; metric: string }>,
): StatsEvent[] | null {
  const text = reader(file);
  if (text === null) return null;
  const out: StatsEvent[] = [];
  for (const { proto, metric } of suffixes) {
    const value = parseSockstatInuse(text, proto);
    if (value === null) continue;
    out.push({ source: "os_network", metric, value, at });
  }
  return out;
}

/** Read real /proc/net connection counts (Linux only). */
export function collectNetworkMetrics(
  reader: ProcNetReader = readProcNetFile,
  at: string = new Date().toISOString(),
): StatsEvent[] {
  const fromSockstat = [
    ...(sockstatEvents(reader, "/proc/net/sockstat", at, [
      { proto: "TCP", metric: "tcp_inuse" },
      { proto: "UDP", metric: "udp_inuse" },
    ]) ?? []),
    ...(sockstatEvents(reader, "/proc/net/sockstat6", at, [
      { proto: "TCP6", metric: "tcp6_inuse" },
      { proto: "UDP6", metric: "udp6_inuse" },
    ]) ?? []),
  ];
  if (fromSockstat.length > 0) return fromSockstat;

  const metrics: StatsEvent[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6", "/proc/net/udp"]) {
    const text = reader(file);
    if (text === null) continue;
    const stats = parseProcNetTable(text);
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
  }
  return metrics;
}
