/**
 * Tests for the daemon stats collection and immune response wiring.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EVOLUTION_DEFAULTS, type EvolutionConfig } from "../../src/config.js";
import { DaemonServer } from "../../src/daemon/server.js";
import { StatsCollector } from "../../src/evolution/stats-collector.js";

const PORT = 19072;

function queuedLlm(...responses: string[]): (s: string, u: string) => Promise<string> {
  const queue = [...responses];
  return async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("unexpected LLM call");
    return next;
  };
}

const CANDIDATE = JSON.stringify([
  {
    id: "ab-stats-1",
    name: "Stats Antibody",
    description: "unknown-threat candidate",
    category: "unknown",
    tier: 0,
    parentIds: [],
    signatures: [{ pattern: "anomalous-signal", type: "exact", label: "signal" }],
    rationale: "statistics-only trigger",
  },
]);

const ACCEPT = JSON.stringify({
  verdict: "accept",
  reason: "covers the unknown cluster",
  suggestion: "",
  duplicateOf: null,
});

describe("daemon stats collection", () => {
  let statsDir: string;
  let evoDir: string;
  let server: DaemonServer;
  let collector: StatsCollector;

  beforeAll(async () => {
    statsDir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-dstats-"));
    evoDir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-devo-"));
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
    server.setEvolutionLlmPair(
      queuedLlm(CANDIDATE),
      queuedLlm(ACCEPT),
    );
    collector = new StatsCollector(statsDir);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("collects events without triggering on a normal baseline", async () => {
    const now = Date.now();
    for (const v of [100, 110, 105]) {
      collector.appendEvent({
        source: "agent_behavior",
        metric: "tool_payload_bytes",
        value: v,
        at: new Date(now).toISOString(),
      });
    }
    const triggers = await server.collectStats();
    expect(triggers).toEqual([]);
  });

  it("triggers on an anomaly and runs an immune response", async () => {
    collector.appendEvent({
      source: "agent_behavior",
      metric: "tool_payload_bytes",
      value: 5000,
      at: new Date(Date.now() + 1000).toISOString(),
    });
    const triggers = await server.collectStats();
    expect(triggers).toHaveLength(1);
    expect(triggers[0].metric).toBe("tool_payload_bytes");

    const triggerLog = path.join(statsDir, "triggers.jsonl");
    expect(fs.existsSync(triggerLog)).toBe(true);
    const line = fs.readFileSync(triggerLog, "utf-8").trim();
    expect(line).toContain("tool_payload_bytes");

    // The immune response should have materialized a shadow candidate.
    const dagFile = path.join(evoDir, "nodes.json");
    expect(fs.existsSync(dagFile)).toBe(true);
    const dag = JSON.parse(fs.readFileSync(dagFile, "utf-8"));
    const node = dag.nodes.find((n: { id: string }) => n.id === "ab-stats-1");
    expect(node).toBeTruthy();
    expect(node.status).toBe("shadow");
  });
});
