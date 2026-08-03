/**
 * Tests for shadow observation and the two-channel promotion mechanism.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AntibodyDagStore } from "../src/evolution/dag-store.js";
import { createEmptyEvidence, type AntibodyNode } from "../src/evolution/dag-types.js";
import { ShadowManager, type ShadowPolicy } from "../src/evolution/shadow.js";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function makePolicy(overrides: Partial<ShadowPolicy> = {}): ShadowPolicy {
  return {
    shadowWindowDays: 7,
    shadowMinScans: 50,
    ...overrides,
  };
}

function makeNode(overrides: Partial<AntibodyNode> = {}): AntibodyNode {
  return {
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
    signatures: [
      { pattern: "ignore all previous instructions", type: "exact", label: "preamble" },
    ],
    evidence: createEmptyEvidence(),
    lastReviewVerdict: "accept",
    ...overrides,
  };
}

describe("ShadowManager", () => {
  let dir: string;
  let dag: AntibodyDagStore;
  let manager: ShadowManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-shadow-"));
    dag = new AntibodyDagStore(dir, {
      activeCap: 256,
      fpPenaltyWeight: 5,
      scoreDecayDays: 90,
      dormantGraceDays: 30,
      retireInactiveDays: 90,
    });
    dag.load();
    manager = new ShadowManager(dag, makePolicy());
  });

  it("moves only candidates into shadow", () => {
    dag.addNode(makeNode());
    expect(manager.startShadow("ab-cand", NOW)).toBe(true);
    expect(dag.getNode("ab-cand")!.status).toBe("shadow");

    expect(manager.startShadow("ab-cand", NOW)).toBe(false); // already shadow
    expect(manager.startShadow("missing", NOW)).toBe(false);
  });

  it("records shadow scans and hits without changing status", () => {
    dag.addNode(makeNode());
    manager.startShadow("ab-cand", NOW);

    const hit = manager.recordScan("ab-cand", "ignore all previous instructions now");
    expect(hit).toBe(true);
    expect(dag.getNode("ab-cand")!.evidence.shadowScans).toBe(1);
    expect(dag.getNode("ab-cand")!.evidence.shadowHits).toBe(1);
    expect(dag.getNode("ab-cand")!.status).toBe("shadow");

    const miss = manager.recordScan("ab-cand", "please summarize the report");
    expect(miss).toBe(false);
    expect(dag.getNode("ab-cand")!.evidence.shadowScans).toBe(2);
    expect(dag.getNode("ab-cand")!.evidence.shadowHits).toBe(1);
  });

  it("ignores scans for non-shadow nodes", () => {
    dag.addNode(makeNode());
    expect(manager.recordScan("ab-cand", "ignore all previous instructions")).toBe(false);
    expect(dag.getNode("ab-cand")!.evidence.shadowScans).toBe(0);
  });

  it("stays pending until the window or scan count elapses", () => {
    dag.addNode(makeNode());
    manager.startShadow("ab-cand", NOW);
    expect(manager.evaluate("ab-cand", NOW)).toBe("pending");

    // Scan-count threshold reached first.
    const afterScans = new ShadowManager(dag, makePolicy({ shadowMinScans: 2 }));
    afterScans.recordScan("ab-cand", "ignore all previous instructions");
    afterScans.recordScan("ab-cand", "ignore all previous instructions");
    afterScans.confirmHit("ab-cand");
    expect(afterScans.evaluate("ab-cand", NOW)).toBe("promote");
  });

  it("promotes after the window with zero FP and a confirmed hit", () => {
    dag.addNode(makeNode());
    manager.startShadow("ab-cand", NOW);
    manager.recordScan("ab-cand", "ignore all previous instructions");
    manager.confirmHit("ab-cand");

    const later = new Date(NOW.getTime() + 8 * DAY);
    expect(manager.evaluate("ab-cand", later)).toBe("promote");
    expect(manager.applyVerdict("ab-cand", later)).toBe("promote");
    expect(dag.getNode("ab-cand")!.status).toBe("active");
  });

  it("demotes when the window elapses without a confirmed hit", () => {
    dag.addNode(makeNode());
    manager.startShadow("ab-cand", NOW);
    manager.recordScan("ab-cand", "ignore all previous instructions"); // hit but unconfirmed

    const later = new Date(NOW.getTime() + 8 * DAY);
    expect(manager.evaluate("ab-cand", later)).toBe("demote");
    expect(manager.applyVerdict("ab-cand", later)).toBe("demote");
    expect(dag.getNode("ab-cand")!.status).toBe("dormant");
  });

  it("demotes immediately on any false positive", () => {
    dag.addNode(makeNode());
    manager.startShadow("ab-cand", NOW);
    dag.recordFalsePositive("ab-cand");
    expect(manager.evaluate("ab-cand", NOW)).toBe("demote");
  });

  it("approves any non-active, non-archived node immediately", () => {
    dag.addNode(makeNode());
    expect(manager.approve("ab-cand")).toBe(true);
    expect(dag.getNode("ab-cand")!.status).toBe("active");

    expect(manager.approve("ab-cand")).toBe(false); // already active
    expect(manager.approve("missing")).toBe(false);
  });

  it("runs promotions across all shadow nodes", () => {
    dag.addNode(makeNode({ id: "good", status: "shadow" }));
    dag.addNode(makeNode({ id: "bad", status: "shadow" }));
    manager.confirmHit("good");
    dag.recordFalsePositive("bad");

    const later = new Date(NOW.getTime() + 8 * DAY);
    const result = manager.runPromotions(later);
    expect(result.promoted).toEqual(["good"]);
    expect(result.demoted).toEqual(["bad"]);
    expect(dag.getNode("good")!.status).toBe("active");
    expect(dag.getNode("bad")!.status).toBe("dormant");
  });
});
