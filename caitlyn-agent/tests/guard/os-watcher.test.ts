/**
 * Tests for OS-graph energy and the detect-only watcher.
 */
import { describe, expect, it } from "vitest";
import {
  computeOsEnergy,
  DEFAULT_OS_ENERGY_CONFIG,
  updateOsEnergyBaseline,
} from "../../src/guard/os-energy.js";
import { isOsTelemetrySource, OsWatcher } from "../../src/guard/os-watcher.js";

const NET_HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const LISTEN =
  "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0";
const ESTAB =
  "   1: 0100007F:9C4C 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0000000000000000 20 4 30 10 -1";

describe("computeOsEnergy", () => {
  it("is zero when current matches baseline", () => {
    const vec = { load1: 1, tcpSockets: 10, memUsedRatio: 0.4 };
    expect(computeOsEnergy(vec, vec)).toBe(0);
  });

  it("sums excess across vertices", () => {
    const energy = computeOsEnergy(
      { load1: 4, tcpSockets: 10 },
      { load1: 1, tcpSockets: 10 },
    );
    expect(energy).toBeCloseTo(3, 5);
  });
});

describe("isOsTelemetrySource", () => {
  it("marks occupancy and network as detect-only sources", () => {
    expect(isOsTelemetrySource("os_occupancy")).toBe(true);
    expect(isOsTelemetrySource("os_network")).toBe(true);
    expect(isOsTelemetrySource("agent_component")).toBe(true);
    expect(isOsTelemetrySource("agent_behavior")).toBe(false);
  });
});

describe("OsWatcher", () => {
  it("stays at none until calibrated, then detects a multi-vertex spike", () => {
    let sockets = [LISTEN];
    let load = "0.10 0.10 0.10 1/100 1\n";
    const mem = "MemTotal: 1000 kB\nMemAvailable: 500 kB\n";
    const stat = "cpu  10 0 10 80 0 0 0 0 0 0\n";
    const reader = (p: string): string | null => {
      if (p === "/proc/loadavg") return load;
      if (p === "/proc/meminfo") return mem;
      if (p === "/proc/stat") return stat;
      if (p === "/proc/net/tcp") return [NET_HEADER, ...sockets].join("\n");
      if (p === "/proc/net/tcp6" || p === "/proc/net/udp") return NET_HEADER + "\n";
      return null;
    };

    const watcher = new OsWatcher({
      ...DEFAULT_OS_ENERGY_CONFIG,
      minSamples: 2,
      energyThreshold: 3,
      reader,
    });

    expect(watcher.tick().intervention).toBe("none");
    expect(watcher.tick().calibrated).toBe(false);
    const calibrated = watcher.tick();
    expect(calibrated.calibrated).toBe(true);
    expect(calibrated.intervention).toBe("none");

    load = "8.00 0.10 0.10 1/800 1\n";
    sockets = [LISTEN, ESTAB, ESTAB, ESTAB, ESTAB, ESTAB, ESTAB, ESTAB, ESTAB];
    const hot = watcher.tick();
    expect(hot.energy).toBeGreaterThanOrEqual(3);
    expect(hot.intervention).toBe("detect");
    expect(hot.events.some((e) => e.source === "os_occupancy")).toBe(true);
    expect(hot.events.some((e) => e.source === "os_network")).toBe(true);
  });
});

describe("updateOsEnergyBaseline", () => {
  it("records the first sample as the EWMA seed", () => {
    const next = updateOsEnergyBaseline({ ewma: {}, sampleCount: 0 }, { load1: 2 }, 0.2);
    expect(next.ewma.load1).toBe(2);
    expect(next.sampleCount).toBe(1);
  });
});
