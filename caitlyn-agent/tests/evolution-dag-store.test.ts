/**
 * Tests for the antibody DAG store: lineage, score, cap enforcement,
 * retirement, archiving, and persistence.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AntibodyDagStore } from "../src/evolution/dag-store.js";
import { createEmptyEvidence, type AntibodyNode, type DagScorePolicy } from "../src/evolution/dag-types.js";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function makeNode(overrides: Partial<AntibodyNode> = {}): AntibodyNode {
  return {
    id: "ab-test",
    name: "Test Antibody",
    description: "test",
    category: "injection",
    tier: 0,
    status: "active",
    parentIds: [],
    createdAt: NOW.toISOString(),
    statusChangedAt: NOW.toISOString(),
    generation: 0,
    signatures: [],
    evidence: createEmptyEvidence(),
    lastReviewVerdict: null,
    ...overrides,
  };
}

function makePolicy(overrides: Partial<DagScorePolicy> = {}): DagScorePolicy {
  return {
    activeCap: 2,
    fpPenaltyWeight: 5,
    scoreDecayDays: 90,
    dormantGraceDays: 30,
    retireInactiveDays: 90,
    ...overrides,
  };
}

describe("AntibodyDagStore", () => {
  let dir: string;
  let store: AntibodyDagStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-dag-"));
    store = new AntibodyDagStore(dir, makePolicy());
    store.load();
  });

  it("adds, gets, lists and renames status", () => {
    store.addNode(makeNode({ id: "a" }));
    expect(store.getNode("a")).not.toBeNull();
    expect(store.listNodes().map((n) => n.id)).toEqual(["a"]);
    expect(store.listNodes("active").map((n) => n.id)).toEqual(["a"]);

    store.setStatus("a", "dormant", NOW);
    expect(store.getNode("a")!.status).toBe("dormant");
    expect(store.listNodes("active")).toEqual([]);
    expect(store.listNodes("dormant").map((n) => n.id)).toEqual(["a"]);
  });

  it("rejects duplicate ids", () => {
    store.addNode(makeNode({ id: "a" }));
    expect(() => store.addNode(makeNode({ id: "a" }))).toThrow(/already exists/);
  });

  it("computes lineage children and active descendants across generations", () => {
    store.addNode(makeNode({ id: "root" }));
    store.addNode(makeNode({ id: "mid", parentIds: ["root"], status: "shadow" }));
    store.addNode(makeNode({ id: "leaf", parentIds: ["mid"], status: "active" }));

    expect(store.childrenOf("root").map((n) => n.id)).toEqual(["mid"]);
    expect(store.hasActiveDescendant("root")).toBe(true);
    expect(store.hasActiveDescendant("mid")).toBe(true);
    expect(store.hasActiveDescendant("leaf")).toBe(false);
  });

  it("scores hits minus weighted false positives with inactivity decay", () => {
    const fresh = makeNode({ id: "fresh" });
    fresh.evidence.hits = 10;
    expect(store.computeScore(fresh, NOW)).toBe(10);

    const decayed = makeNode({ id: "decayed", createdAt: isoDaysAgo(45) });
    decayed.evidence.hits = 10;
    expect(store.computeScore(decayed, NOW)).toBeCloseTo(5, 5);

    const fp = makeNode({ id: "fp" });
    fp.evidence.hits = 10;
    fp.evidence.falsePositives = 3;
    fp.evidence.lastUsedAt = isoDaysAgo(90); // decay to 0 for hits
    expect(store.computeScore(fp, NOW)).toBe(-15); // penalty never decays
  });

  it("enforces the active cap and demotes only negative or covered nodes", () => {
    store.addNode(makeNode({ id: "root", evidence: { ...createEmptyEvidence(), hits: 100 } }));
    store.addNode(
      makeNode({
        id: "child",
        parentIds: ["root"],
        evidence: { ...createEmptyEvidence(), hits: 200 },
      }),
    );
    store.addNode(
      makeNode({
        id: "bad",
        evidence: { ...createEmptyEvidence(), falsePositives: 5 },
      }),
    );
    store.addNode(
      makeNode({
        id: "orphan-low",
        evidence: { ...createEmptyEvidence(), hits: 1 },
      }),
    );

    const demoted = store.enforceActiveCap(NOW);
    // cap=2: bad (score -25) and child? child covered by nobody and positive.
    // root is covered by child (child score >= root score) so root is demotable.
    // Low-score ordering: bad(-25) < orphan-low(1) < root(100) < child(200).
    // Candidates: bad (negative), root (covered by child with >= score), child? no descendant.
    expect(demoted).toEqual(["bad", "root"]);
    expect(store.getNode("bad")!.status).toBe("dormant");
    expect(store.getNode("root")!.status).toBe("dormant");
    expect(store.getNode("child")!.status).toBe("active");
    expect(store.getNode("orphan-low")!.status).toBe("active");
  });

  it("retires negative-score and long-inactive covered antibodies", () => {
    store.addNode(
      makeNode({
        id: "root",
        createdAt: isoDaysAgo(200),
        evidence: { ...createEmptyEvidence(), hits: 5 },
      }),
    );
    store.addNode(
      makeNode({
        id: "child",
        parentIds: ["root"],
        createdAt: isoDaysAgo(200),
        evidence: { ...createEmptyEvidence(), hits: 1 },
      }),
    );
    store.addNode(
      makeNode({
        id: "neg",
        evidence: { ...createEmptyEvidence(), falsePositives: 2 },
      }),
    );

    const retired = store.retireInactive(NOW);
    expect(retired).toContain("neg");
    expect(retired).toContain("root"); // inactive 200d (createdAt) + covered by child
    expect(store.getNode("child")!.status).toBe("active"); // no descendant coverage
  });

  it("archives dormant nodes after the grace period", () => {
    store.addNode(
      makeNode({ id: "old", status: "dormant", statusChangedAt: isoDaysAgo(31) }),
    );
    store.addNode(
      makeNode({ id: "young", status: "dormant", statusChangedAt: isoDaysAgo(10) }),
    );

    const archived = store.archiveExpiredDormant(NOW);
    expect(archived).toEqual(["old"]);
    expect(store.getNode("old")).toBeNull();
    expect(store.getNode("young")).not.toBeNull();

    const log = store.listArchived();
    expect(log.map((e) => e.node.id)).toEqual(["old"]);
    expect(log[0].archivedAt).toBe(NOW.toISOString());
  });

  it("persists and reloads the DAG", () => {
    store.addNode(makeNode({ id: "a" }));
    store.addNode(makeNode({ id: "b", parentIds: ["a"] }));
    store.recordHit("a", NOW);
    store.save();

    const reloaded = new AntibodyDagStore(dir, makePolicy());
    reloaded.load();
    expect(reloaded.listNodes().map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(reloaded.getNode("a")!.evidence.hits).toBe(1);
    expect(reloaded.getNode("a")!.evidence.lastUsedAt).toBe(NOW.toISOString());
  });

  it("updates evidence counters and lastUsedAt", () => {
    store.addNode(makeNode({ id: "a" }));
    const later = new Date(NOW.getTime() + DAY);
    store.recordHit("a", later);
    store.recordFalsePositive("a", later);
    store.recordShadowScan("a", later);
    store.recordShadowHit("a");
    store.confirmShadowHit("a");

    const ev = store.getNode("a")!.evidence;
    expect(ev.hits).toBe(1);
    expect(ev.falsePositives).toBe(1);
    expect(ev.shadowScans).toBe(1);
    expect(ev.shadowHits).toBe(1);
    expect(ev.shadowConfirmedHits).toBe(1);
    expect(ev.lastUsedAt).toBe(later.toISOString());
  });
});
