/**
 * Tests for the OS/network probe: /proc table parsing and metric
 * collection.
 */
import { describe, it, expect } from "vitest";
import {
  collectNetworkMetrics,
  parseProcNetTable,
  parseSockstatInuse,
} from "../src/evolution/network-probe.js";

const SAMPLE_TCP = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0",
  "   1: 0100007F:9C4C 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 12346 1 0000000000000000 20 4 30 10 -1",
  "   2: 00000000:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12347 1 0000000000000000 100 0 0 10 0",
  "",
].join("\n");

describe("parseProcNetTable", () => {
  it("counts total sockets and ESTABLISHED connections", () => {
    const stats = parseProcNetTable(SAMPLE_TCP);
    expect(stats.total).toBe(3);
    expect(stats.established).toBe(1);
  });

  it("handles empty or header-only content", () => {
    expect(parseProcNetTable("")).toEqual({ established: 0, total: 0 });
    expect(parseProcNetTable("  sl  local_address rem_address   st\n")).toEqual({
      established: 0,
      total: 0,
    });
  });
});

describe("parseSockstatInuse", () => {
  it("reads TCP inuse from sockstat", () => {
    const text = [
      "sockets: used 140",
      "TCP: inuse 32 orphan 0 tw 19 alloc 34 mem 3",
      "UDP: inuse 8 mem 4",
      "",
    ].join("\n");
    expect(parseSockstatInuse(text, "TCP")).toBe(32);
    expect(parseSockstatInuse(text, "UDP")).toBe(8);
  });
});

describe("collectNetworkMetrics", () => {
  it("returns well-formed os_network events (or none on non-Linux)", () => {
    const metrics = collectNetworkMetrics();
    for (const m of metrics) {
      expect(m.source).toBe("os_network");
      expect(m.metric).toMatch(/^(tcp|tcp6|udp|udp6)_(sockets|established|inuse)$/);
      expect(m.value).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(Date.parse(m.at))).toBe(true);
    }
  });

  it("uses an injected reader without inventing sockets", () => {
    const table = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:9C4C 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0000000000000000 20 4 30 10 -1",
      "",
    ].join("\n");
    const reader = (p: string) => (p === "/proc/net/tcp" ? table : null);
    const metrics = collectNetworkMetrics(reader, "2026-10-19T00:00:00.000Z");
    const sockets = metrics.find((m) => m.metric === "tcp_sockets");
    const established = metrics.find((m) => m.metric === "tcp_established");
    expect(sockets?.value).toBe(2);
    expect(established?.value).toBe(1);
    expect(metrics.some((m) => m.metric.startsWith("udp_"))).toBe(false);
  });
});
