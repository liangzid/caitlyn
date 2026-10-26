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
 * Parse `TCP: inuse N orphan N tw N` style key/value pairs.
 * Missing keys stay absent. This is O(1) in socket count.
 */
export function parseSockstatFields(
  text: string,
  proto: string,
): Record<string, number> | null {
  const prefix = `${proto}:`;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const parts = trimmed.slice(prefix.length).trim().split(/\s+/);
    const out: Record<string, number> = {};
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const value = Number(parts[i + 1]);
      if (!Number.isFinite(value)) continue;
      out[parts[i]] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}

/** Parse `TCP: inuse N` / `UDP: inuse N` from sockstat. */
export function parseSockstatInuse(text: string, proto: string): number | null {
  const fields = parseSockstatFields(text, proto);
  const value = fields?.inuse;
  return typeof value === "number" ? value : null;
}

function sockstatEvents(
  reader: ProcNetReader,
  file: string,
  at: string,
  mappings: Array<{ proto: string; field: string; metric: string }>,
): StatsEvent[] | null {
  const text = reader(file);
  if (text === null) return null;
  const out: StatsEvent[] = [];
  for (const { proto, field, metric } of mappings) {
    const fields = parseSockstatFields(text, proto);
    const value = fields?.[field];
    if (typeof value !== "number") continue;
    out.push({ source: "os_network", metric, value, at });
  }
  return out.length > 0 ? out : [];
}

/** Read real /proc/net connection counts (Linux only). */
export function collectNetworkMetrics(
  reader: ProcNetReader = readProcNetFile,
  at: string = new Date().toISOString(),
): StatsEvent[] {
  const fromSockstat = [
    ...(sockstatEvents(reader, "/proc/net/sockstat", at, [
      { proto: "TCP", field: "inuse", metric: "tcp_inuse" },
      { proto: "TCP", field: "orphan", metric: "tcp_orphan" },
      { proto: "TCP", field: "tw", metric: "tcp_tw" },
      { proto: "UDP", field: "inuse", metric: "udp_inuse" },
    ]) ?? []),
    ...(sockstatEvents(reader, "/proc/net/sockstat6", at, [
      { proto: "TCP6", field: "inuse", metric: "tcp6_inuse" },
      { proto: "UDP6", field: "inuse", metric: "udp6_inuse" },
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
