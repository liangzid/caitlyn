/**
 * CAITLYN Evolution — Antibody DAG Store
 *
 * Persists the antibody DAG to <evolutionDir>/nodes.json and archives
 * retired nodes to <evolutionDir>/archive.jsonl (append-only).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AntibodyNode, DagScorePolicy, NodeStatus } from "./dag-types.js";

const NODES_FILE = "nodes.json";
const ARCHIVE_FILE = "archive.jsonl";
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(now: Date): string {
  return now.toISOString();
}

function daysBetween(fromIso: string, now: Date): number {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return 0;
  return Math.max(0, (now.getTime() - from) / DAY_MS);
}

export class AntibodyDagStore {
  private nodes = new Map<string, AntibodyNode>();
  private nodesPath: string;
  private archivePath: string;
  private policy: DagScorePolicy;

  constructor(evolutionDir: string, policy: DagScorePolicy) {
    this.nodesPath = path.join(evolutionDir, NODES_FILE);
    this.archivePath = path.join(evolutionDir, ARCHIVE_FILE);
    this.policy = policy;
  }

  /** Load persisted nodes. Missing or corrupt files start with an empty DAG. */
  load(): void {
    this.nodes.clear();
    try {
      const raw = fs.readFileSync(this.nodesPath, "utf-8");
      const parsed = JSON.parse(raw) as { nodes: AntibodyNode[] };
      for (const node of parsed.nodes ?? []) {
        if (node && typeof node.id === "string") {
          this.nodes.set(node.id, node);
        }
      }
    } catch {
      // Missing or corrupt — start fresh.
    }
  }

  /** Atomically persist the current DAG (tmp file + rename). */
  save(): void {
    fs.mkdirSync(path.dirname(this.nodesPath), { recursive: true });
    const payload = JSON.stringify({ nodes: [...this.nodes.values()] }, null, 2);
    const tmp = `${this.nodesPath}.tmp`;
    fs.writeFileSync(tmp, payload, "utf-8");
    fs.renameSync(tmp, this.nodesPath);
  }

  addNode(node: AntibodyNode): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`Antibody node already exists: ${node.id}`);
    }
    this.nodes.set(node.id, { ...node });
  }

  getNode(id: string): AntibodyNode | null {
    return this.nodes.get(id) ?? null;
  }

  listNodes(status?: NodeStatus): AntibodyNode[] {
    const all = [...this.nodes.values()];
    return status === undefined ? all : all.filter((n) => n.status === status);
  }

  /** Direct children (nodes whose parentIds include the given id). */
  childrenOf(id: string): AntibodyNode[] {
    return [...this.nodes.values()].filter((n) => n.parentIds.includes(id));
  }

  /** True if any active descendant (child, grandchild, ...) exists. */
  hasActiveDescendant(id: string): boolean {
    const seen = new Set<string>();
    const stack = this.childrenOf(id);
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (node.status === "active") return true;
      stack.push(...this.childrenOf(node.id));
    }
    return false;
  }

  /**
   * Derived score: positive contribution decays with inactivity, the
   * false-positive penalty never decays.
   */
  computeScore(node: AntibodyNode, now: Date = new Date()): number {
    const reference = node.evidence.lastUsedAt ?? node.createdAt;
    const inactiveDays = daysBetween(reference, now);
    const decay = Math.max(0, 1 - inactiveDays / this.policy.scoreDecayDays);
    return (
      node.evidence.hits * decay -
      this.policy.fpPenaltyWeight * node.evidence.falsePositives
    );
  }

  recordHit(id: string, now: Date = new Date()): void {
    const node = this.requireNode(id);
    node.evidence.hits += 1;
    node.evidence.lastUsedAt = iso(now);
  }

  recordFalsePositive(id: string, now: Date = new Date()): void {
    const node = this.requireNode(id);
    node.evidence.falsePositives += 1;
    node.evidence.lastUsedAt = iso(now);
  }

  recordShadowScan(id: string, now: Date = new Date()): void {
    const node = this.requireNode(id);
    node.evidence.shadowScans += 1;
    node.evidence.lastUsedAt = iso(now);
  }

  recordShadowHit(id: string): void {
    this.requireNode(id).evidence.shadowHits += 1;
  }

  confirmShadowHit(id: string): void {
    this.requireNode(id).evidence.shadowConfirmedHits += 1;
  }

  setStatus(id: string, status: NodeStatus, now: Date = new Date()): void {
    const node = this.requireNode(id);
    node.status = status;
    node.statusChangedAt = iso(now);
  }

  /**
   * Enforce the active cap. Only low-score nodes that are either negative
   * or covered by an active descendant may be demoted (L6 retirement guard).
   * Returns the ids demoted to dormant.
   */
  enforceActiveCap(now: Date = new Date()): string[] {
    const active = this.listNodes("active")
      .map((n) => ({ node: n, score: this.computeScore(n, now) }))
      .sort((a, b) => a.score - b.score);
    const excess = active.length - this.policy.activeCap;
    if (excess <= 0) return [];

    const demoted: string[] = [];
    for (const { node, score } of active) {
      if (demoted.length >= excess) break;
      const covered =
        this.hasActiveDescendant(node.id) &&
        this.maxActiveDescendantScore(node.id, now) >= score;
      if (score < 0 || covered) {
        this.setStatus(node.id, "dormant", now);
        demoted.push(node.id);
      }
    }
    return demoted;
  }

  /**
   * Demote inactive or harmful active antibodies to dormant.
   * Returns the ids demoted.
   */
  retireInactive(now: Date = new Date()): string[] {
    const retired: string[] = [];
    for (const node of this.listNodes("active")) {
      const score = this.computeScore(node, now);
      const reference = node.evidence.lastUsedAt ?? node.createdAt;
      const inactiveDays = daysBetween(reference, now);
      const covered = this.hasActiveDescendant(node.id);
      if (score < 0 || (inactiveDays >= this.policy.retireInactiveDays && covered)) {
        this.setStatus(node.id, "dormant", now);
        retired.push(node.id);
      }
    }
    return retired;
  }

  /**
   * Archive dormant nodes whose grace period expired.
   * Archived nodes move to archive.jsonl and leave the active DAG file.
   * Returns the archived ids.
   */
  archiveExpiredDormant(now: Date = new Date()): string[] {
    const archived: string[] = [];
    for (const node of this.listNodes("dormant")) {
      if (daysBetween(node.statusChangedAt, now) < this.policy.dormantGraceDays) continue;
      this.appendArchive(node, now);
      this.nodes.delete(node.id);
      archived.push(node.id);
    }
    return archived;
  }

  /** Read archived nodes (append-only log, oldest first). */
  listArchived(): Array<{ archivedAt: string; node: AntibodyNode }> {
    try {
      const raw = fs.readFileSync(this.archivePath, "utf-8");
      const out: Array<{ archivedAt: string; node: AntibodyNode }> = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { archivedAt: string; node: AntibodyNode };
          out.push(entry);
        } catch {
          // Skip malformed archive lines.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private maxActiveDescendantScore(rootId: string, now: Date): number {
    const seen = new Set<string>();
    const stack = this.childrenOf(rootId);
    let max = -Infinity;
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (node.status === "active") {
        max = Math.max(max, this.computeScore(node, now));
      }
      stack.push(...this.childrenOf(node.id));
    }
    return max === -Infinity ? -Infinity : max;
  }

  private appendArchive(node: AntibodyNode, now: Date): void {
    fs.mkdirSync(path.dirname(this.archivePath), { recursive: true });
    const entry = JSON.stringify({ archivedAt: iso(now), node });
    fs.appendFileSync(this.archivePath, `${entry}\n`, "utf-8");
  }

  private requireNode(id: string): AntibodyNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown antibody node: ${id}`);
    return node;
  }
}
