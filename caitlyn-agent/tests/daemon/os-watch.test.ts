/**
 * Tests for daemon OS-watcher wiring: occupancy triggers stay detect-only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EVOLUTION_DEFAULTS, type EvolutionConfig } from "../../src/config.js";
import { DaemonServer } from "../../src/daemon/server.js";
import { StatsCollector } from "../../src/evolution/stats-collector.js";

const PORT = 19073;

describe("daemon OS watcher synthesis skip", () => {
  let statsDir: string;
  let evoDir: string;
  let server: DaemonServer;
  let collector: StatsCollector;
  let llmCalls = 0;

  beforeAll(async () => {
    statsDir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-oswatch-"));
    evoDir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-oswatch-evo-"));
    const evolutionConfig: EvolutionConfig = {
      ...EVOLUTION_DEFAULTS,
      evolutionDir: evoDir,
      autonomy: "auto",
      benignSamples: 5,
      maxBenignFalsePositives: 1,
      regexTimeoutMs: 200,
    };
    server = new DaemonServer({
      port: PORT,
      statsDir,
      evolutionConfig,
    });
    const countingLlm = async () => {
      llmCalls += 1;
      throw new Error("LLM must not run for OS occupancy");
    };
    server.setEvolutionLlmPair(countingLlm, countingLlm);
    collector = new StatsCollector(statsDir);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("does not synthesize when os_occupancy spikes", async () => {
    const now = Date.now();
    for (const v of [100, 110, 105]) {
      collector.appendEvent({
        source: "os_occupancy",
        metric: "os_watch_test_load",
        value: v,
        at: new Date(now).toISOString(),
      });
    }
    await server.collectStats();
    collector.appendEvent({
      source: "os_occupancy",
      metric: "os_watch_test_load",
      value: 5000,
      at: new Date(now + 1000).toISOString(),
    });
    const triggers = await server.collectStats();
    const occupancy = triggers.filter((t) => t.metric === "os_watch_test_load");
    expect(occupancy).toHaveLength(1);
    expect(llmCalls).toBe(0);
    expect(fs.existsSync(path.join(evoDir, "nodes.json"))).toBe(false);
  });
});
