/**
 * Tests for Linux occupancy parsers and live collection.
 */
import { describe, expect, it } from "vitest";
import {
  collectOccupancyMetrics,
  cpuBusyRatio,
  parseProcLoadavg,
  parseProcMeminfo,
  parseProcStatCpu,
  readProcFile,
} from "../../src/guard/os-occupancy.js";

const PROC_STAT = [
  "cpu  10 0 10 80 0 0 0 0 0 0",
  "cpu0 10 0 10 80 0 0 0 0 0 0",
  "intr 1",
  "",
].join("\n");

const PROC_STAT_BUSY = [
  "cpu  50 0 50 100 0 0 0 0 0 0",
  "cpu0 50 0 50 100 0 0 0 0 0 0",
  "",
].join("\n");

const PROC_LOAD = "0.12 0.07 0.01 1/234 12345\n";

const PROC_MEM = [
  "MemTotal:        1000 kB",
  "MemFree:          100 kB",
  "MemAvailable:     400 kB",
  "Buffers:           10 kB",
  "",
].join("\n");

describe("parseProcStatCpu", () => {
  it("sums idle and total jiffies on the aggregate cpu line", () => {
    const cpu = parseProcStatCpu(PROC_STAT);
    expect(cpu).toEqual({ idle: 80, total: 100 });
  });

  it("returns null on empty or header-less text", () => {
    expect(parseProcStatCpu("")).toBeNull();
    expect(parseProcStatCpu("cpu0 1 2 3 4\n")).toBeNull();
  });
});

describe("cpuBusyRatio", () => {
  it("computes busy fraction from a counter delta", () => {
    const prev = parseProcStatCpu(PROC_STAT)!;
    const next = parseProcStatCpu(PROC_STAT_BUSY)!;
    expect(cpuBusyRatio(prev, next)).toBeCloseTo(0.8, 5);
  });

  it("returns null when the counter does not advance", () => {
    const cpu = parseProcStatCpu(PROC_STAT)!;
    expect(cpuBusyRatio(cpu, cpu)).toBeNull();
  });
});

describe("parseProcLoadavg", () => {
  it("reads load and process-table size", () => {
    expect(parseProcLoadavg(PROC_LOAD)).toEqual({
      load1: 0.12,
      load5: 0.07,
      load15: 0.01,
      runnable: 1,
      processes: 234,
    });
  });
});

describe("parseProcMeminfo", () => {
  it("computes used ratio from MemTotal and MemAvailable", () => {
    const mem = parseProcMeminfo(PROC_MEM);
    expect(mem).toEqual({ memTotalKb: 1000, memAvailableKb: 400 });
  });
});

describe("collectOccupancyMetrics", () => {
  it("emits os_occupancy events from a recorded procfs snapshot", () => {
    const files: Record<string, string> = {
      "/proc/loadavg": PROC_LOAD,
      "/proc/meminfo": PROC_MEM,
      "/proc/stat": PROC_STAT,
    };
    const reader = (p: string) => files[p] ?? null;
    const first = collectOccupancyMetrics(reader, null, "2026-10-19T00:00:00.000Z");
    expect(first.features.load1).toBe(0.12);
    expect(first.features.processes).toBe(234);
    expect(first.features.memUsedRatio).toBeCloseTo(0.6, 5);
    expect(first.features.cpuBusy).toBeUndefined();
    expect(first.events.every((e) => e.source === "os_occupancy")).toBe(true);

    files["/proc/stat"] = PROC_STAT_BUSY;
    const second = collectOccupancyMetrics(reader, first.cpu, "2026-10-19T00:00:01.000Z");
    expect(second.features.cpuBusy).toBeCloseTo(0.8, 5);
  });

  it("reads live /proc when the files exist, otherwise emits nothing", () => {
    const live = collectOccupancyMetrics(readProcFile);
    const load = readProcFile("/proc/loadavg");
    if (load === null) {
      expect(live.events).toEqual([]);
      return;
    }
    expect(live.features.load1).toBeGreaterThanOrEqual(0);
    expect(live.features.processes).toBeGreaterThan(0);
  });
});
