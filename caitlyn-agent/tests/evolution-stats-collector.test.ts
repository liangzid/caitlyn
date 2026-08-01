/**
 * Tests for the stats collector: event append, EWMA/p99 baseline,
 * anomaly triggers, cooldown, daily limits, idempotency, window pruning,
 * and persistence.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeP99,
  StatsCollector,
  type StatsCollectorConfig,
  type StatsEvent,
} from "../src/evolution/stats-collector.js";

const NOW = new Date("2026-08-01T00:00:00.000Z");

function makeConfig(overrides: Partial<StatsCollectorConfig> = {}): StatsCollectorConfig {
  return {
    ewmaAlpha: 0.5,
    windowMs: 60 * 60 * 1000,
    anomalyFactor: 3,
    minAbsoluteDelta: 1,
    cooldownMinutes: 60,
    dailyEvolutionLimit: 10,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<StatsEvent> = {}): StatsEvent {
  return {
    source: "agent_behavior",
    metric: "tool_calls_per_minute",
    value: 10,
    at: NOW.toISOString(),
    ...overrides,
  };
}

function minutesLater(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60 * 1000).toISOString();
}

describe("computeP99", () => {
  it("returns 0 for an empty list", () => {
    expect(computeP99([])).toBe(0);
  });

  it("uses nearest-rank p99", () => {
    expect(computeP99([1, 2, 3, 4])).toBe(4);
    expect(computeP99([1, 2, 3])).toBe(3);
    expect(computeP99([1, 1, 1, 2])).toBe(2);
  });
});

describe("StatsCollector", () => {
  let dir: string;
  let collector: StatsCollector;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-stats-"));
    collector = new StatsCollector(dir, makeConfig());
    collector.load();
  });

  it("appends events to events.jsonl", () => {
    collector.appendEvent(makeEvent());
    collector.appendEvent(makeEvent({ metric: "files_written_per_minute", value: 2 }));

    const lines = fs
      .readFileSync(path.join(dir, "events.jsonl"), "utf-8")
      .trim()
      .split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(collector.readEvents()).toHaveLength(2);
  });

  it("builds a baseline without triggering on the first collect", () => {
    collector.appendEvent(makeEvent({ value: 10 }));
    collector.appendEvent(makeEvent({ value: 12 }));
    collector.appendEvent(makeEvent({ value: 11 }));

    const triggers = collector.collect(new Date(NOW.getTime() + 1000));
    expect(triggers).toEqual([]);

    const baseline = collector.baselineFor("tool_calls_per_minute");
    expect(baseline.sampleCount).toBe(3);
    expect(baseline.ewma).toBeCloseTo(11, 5);
    expect(baseline.p99).toBe(12);
  });

  it("triggers when a value far exceeds the baseline", () => {
    for (const v of [10, 12, 11]) {
      collector.appendEvent(makeEvent({ value: v }));
    }
    collector.collect(new Date(NOW.getTime() + 1000));

    collector.appendEvent(makeEvent({ value: 500, at: minutesLater(1) }));
    const triggers = collector.collect(new Date(NOW.getTime() + 60_1000));
    expect(triggers).toHaveLength(1);
    expect(triggers[0].metric).toBe("tool_calls_per_minute");
    expect(triggers[0].value).toBe(500);
    expect(triggers[0].baselineP99).toBe(12);
  });

  it("respects the per-metric cooldown but still updates the baseline", () => {
    for (const v of [10, 12, 11]) {
      collector.appendEvent(makeEvent({ value: v }));
    }
    collector.collect(new Date(NOW.getTime() + 1000));

    collector.appendEvent(makeEvent({ value: 500, at: minutesLater(1) }));
    const first = collector.collect(new Date(NOW.getTime() + 60_1000));
    expect(first).toHaveLength(1);

    // Same metric again within the 60-minute cooldown.
    collector.appendEvent(makeEvent({ value: 900, at: minutesLater(2) }));
    const second = collector.collect(new Date(NOW.getTime() + 120_1000));
    expect(second).toEqual([]);

    // A different metric (with its own baseline) is not affected by the cooldown.
    collector.appendEvent(
      makeEvent({ metric: "files_written_per_minute", value: 10, at: minutesLater(2) }),
    );
    collector.appendEvent(
      makeEvent({ metric: "files_written_per_minute", value: 12, at: minutesLater(2) }),
    );
    collector.appendEvent(
      makeEvent({ metric: "files_written_per_minute", value: 11, at: minutesLater(2) }),
    );
    collector.appendEvent(
      makeEvent({ metric: "files_written_per_minute", value: 500, at: minutesLater(2) }),
    );
    const other = collector.collect(new Date(NOW.getTime() + 120_1000));
    expect(other).toHaveLength(1);
    expect(other[0].metric).toBe("files_written_per_minute");
  });

  it("stops triggering after the daily limit", () => {
    collector = new StatsCollector(dir, makeConfig({ dailyEvolutionLimit: 1 }));
    collector.load();

    for (const v of [10, 12, 11]) {
      collector.appendEvent(makeEvent({ metric: "m1", value: v }));
      collector.appendEvent(makeEvent({ metric: "m2", value: v }));
    }
    collector.collect(new Date(NOW.getTime() + 1000));

    collector.appendEvent(makeEvent({ metric: "m1", value: 500, at: minutesLater(1) }));
    const first = collector.collect(new Date(NOW.getTime() + 60_1000));
    expect(first).toHaveLength(1);

    collector.appendEvent(makeEvent({ metric: "m2", value: 500, at: minutesLater(2) }));
    const second = collector.collect(new Date(NOW.getTime() + 120_1000));
    expect(second).toEqual([]);
  });

  it("is idempotent: reprocessing without new events triggers nothing", () => {
    collector.appendEvent(makeEvent({ value: 10 }));
    collector.appendEvent(makeEvent({ value: 500, at: minutesLater(1) }));
    const first = collector.collect(new Date(NOW.getTime() + 60_1000));
    expect(first).toHaveLength(1);

    const second = collector.collect(new Date(NOW.getTime() + 61_000));
    expect(second).toEqual([]);
  });

  it("prunes observations outside the window", () => {
    collector = new StatsCollector(dir, makeConfig({ windowMs: 60 * 1000 }));
    collector.load();

    collector.appendEvent(makeEvent({ value: 10, at: NOW.toISOString() }));
    collector.appendEvent(makeEvent({ value: 12, at: minutesLater(5) }));
    collector.collect(new Date(NOW.getTime() + 5 * 60_000 + 1000));

    const baseline = collector.baselineFor("tool_calls_per_minute");
    expect(baseline.values.map((v) => v.value)).toEqual([12]);
    expect(baseline.p99).toBe(12);
  });

  it("persists the cursor so a restarted collector does not reprocess", () => {
    collector.appendEvent(makeEvent({ value: 10 }));
    collector.collect(new Date(NOW.getTime() + 1000));
    collector.save();

    const restarted = new StatsCollector(dir, makeConfig());
    restarted.load();
    expect(restarted.collect(new Date(NOW.getTime() + 2000))).toEqual([]);
    expect(restarted.baselineFor("tool_calls_per_minute").sampleCount).toBe(1);
  });
});
