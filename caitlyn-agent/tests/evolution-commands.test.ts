/**
 * Tests for the evolution CLI command helpers: approval and DAG status.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EVOLUTION_DEFAULTS, type EvolutionConfig } from "../src/config.js";
import { AntibodyDagStore } from "../src/evolution/dag-store.js";
import { createEmptyEvidence } from "../src/evolution/dag-types.js";
import { dagPolicyFrom } from "../src/evolution/engine.js";
import { approveAntibody, printEvolutionStatus } from "../src/commands/evolution.js";

const NOW = new Date("2026-08-01T00:00:00.000Z");

describe("evolution commands", () => {
  let dir: string;
  let config: EvolutionConfig;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-cmd-"));
    config = { ...EVOLUTION_DEFAULTS, evolutionDir: dir };
    const dag = new AntibodyDagStore(dir, dagPolicyFrom(config));
    dag.load();
    dag.addNode({
      id: "ab-cand",
      name: "Candidate",
      description: "candidate",
      category: "injection",
      tier: 0,
      status: "candidate",
      parentIds: [],
      createdAt: NOW.toISOString(),
      statusChangedAt: NOW.toISOString(),
      generation: 1,
      signatures: [],
      evidence: createEmptyEvidence(),
      lastReviewVerdict: "accept",
    });
    dag.save();
  });

  it("approves a candidate via the explicit channel", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    approveAntibody("ab-cand", config);
    const dag = new AntibodyDagStore(dir, dagPolicyFrom(config));
    dag.load();
    expect(dag.getNode("ab-cand")!.status).toBe("active");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("approved and activated"));
    log.mockRestore();
  });

  it("refuses to approve unknown or already active ids", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    approveAntibody("missing", config);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Cannot approve"));
    approveAntibody("ab-cand", config);
    approveAntibody("ab-cand", config);
    expect(log).toHaveBeenCalledTimes(3);
    log.mockRestore();
  });

  it("prints DAG status lines", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printEvolutionStatus(config);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Evolution DAG: 1 nodes"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ab-cand [candidate]"));
    log.mockRestore();
  });
});
