/**
 * Tests for stats event producers: env override and default placement.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { testHomeId } = vi.hoisted(() => ({
  testHomeId: "caitlyn-stats-events-home-" + Date.now().toString(36),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const base = actual.tmpdir() + "/" + testHomeId;
  return { ...actual, homedir: () => base };
});

import { appendStatsEvent, appendTriggerRecord } from "../src/evolution/stats-events.js";

afterEach(() => {
  delete process.env.CAITLYN_STATS_DIR;
  try {
    fs.rmSync(path.join(os.tmpdir(), testHomeId), {
      recursive: true,
      force: true,
    });
  } catch {
    // Best effort cleanup.
  }
});

describe("stats event producers", () => {
  it("writes events to the CAITLYN_STATS_DIR override", () => {
    const override = path.join(os.tmpdir(), `${testHomeId}-override`);
    process.env.CAITLYN_STATS_DIR = override;
    appendStatsEvent("agent_behavior", "tool_payload_bytes", 42);
    const lines = fs
      .readFileSync(path.join(override, "events.jsonl"), "utf-8")
      .trim()
      .split(/\r?\n/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"metric":"tool_payload_bytes"');
  });

  it("writes trigger records to the override directory", () => {
    const override = path.join(os.tmpdir(), `${testHomeId}-triggers`);
    process.env.CAITLYN_STATS_DIR = override;
    appendTriggerRecord({
      source: "os_network",
      metric: "tcp_established",
      value: 500,
      baselineEwma: 10,
      baselineP99: 12,
      at: "2026-08-03T00:00:00.000Z",
    });
    const raw = fs.readFileSync(path.join(override, "triggers.jsonl"), "utf-8");
    expect(raw).toContain("tcp_established");
  });
});
