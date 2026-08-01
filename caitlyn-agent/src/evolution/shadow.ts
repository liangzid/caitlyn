/**
 * CAITLYN Evolution — Shadow Observation & Promotion
 *
 * Candidate antibodies are observed in shadow mode (record-only, never
 * blocking). Promotion is two-channel: explicit approval by user/agent,
 * or a shadow observation window with zero false positives and at least
 * one confirmed suspicious hit. Any false positive demotes immediately.
 */

import { AntibodyDagStore } from "./dag-store.js";
import { isDangerousRegex } from "./verifier.js";

export interface ShadowPolicy {
  shadowWindowDays: number;
  shadowMinScans: number;
}

export type PromotionVerdict = "pending" | "promote" | "demote";

const DAY_MS = 24 * 60 * 60 * 1000;

export class ShadowManager {
  constructor(
    private dag: AntibodyDagStore,
    private policy: ShadowPolicy,
  ) {}

  /** Move a candidate into shadow observation. */
  startShadow(id: string, now: Date = new Date()): boolean {
    const node = this.dag.getNode(id);
    if (!node || node.status !== "candidate") return false;
    this.dag.setStatus(id, "shadow", now);
    return true;
  }

  /**
   * Record one shadow scan for a candidate (record-only). Returns true
   * when the content hit the candidate's signatures.
   */
  recordScan(id: string, content: string, now: Date = new Date()): boolean {
    const node = this.dag.getNode(id);
    if (!node || node.status !== "shadow") return false;
    this.dag.recordShadowScan(id, now);

    let hit = false;
    for (const sig of node.signatures) {
      if (sig.type === "regex") {
        if (isDangerousRegex(sig.pattern)) continue;
        try {
          if (new RegExp(sig.pattern, "i").test(content)) hit = true;
        } catch {
          // Invalid regex — skip.
        }
      } else if (content.includes(sig.pattern)) {
        hit = true;
      }
    }
    if (hit) this.dag.recordShadowHit(id);
    return hit;
  }

  /** Mark a shadow hit as confirmed suspicious (by user or downstream check). */
  confirmHit(id: string): void {
    this.dag.confirmShadowHit(id);
  }

  /** Explicit approval channel: any candidate/shadow/dormant → active. */
  approve(id: string, now: Date = new Date()): boolean {
    const node = this.dag.getNode(id);
    if (!node || node.status === "active" || node.status === "archived") return false;
    this.dag.setStatus(id, "active", now);
    return true;
  }

  /**
   * Evaluate one shadow node against the observation window.
   * Any false positive demotes immediately; otherwise the window is
   * "elapsed" when days >= shadowWindowDays OR scans >= shadowMinScans.
   */
  evaluate(id: string, now: Date = new Date()): PromotionVerdict {
    const node = this.dag.getNode(id);
    if (!node || node.status !== "shadow") return "pending";
    if (node.evidence.falsePositives > 0) return "demote";

    const elapsedDays =
      (now.getTime() - Date.parse(node.statusChangedAt)) / DAY_MS;
    const windowElapsed =
      elapsedDays >= this.policy.shadowWindowDays ||
      node.evidence.shadowScans >= this.policy.shadowMinScans;
    if (!windowElapsed) return "pending";

    return node.evidence.shadowConfirmedHits >= 1 ? "promote" : "demote";
  }

  /**
   * Apply the verdict: promote → active, demote → dormant.
   * Returns the applied verdict or null when pending.
   */
  applyVerdict(id: string, now: Date = new Date()): PromotionVerdict | null {
    const verdict = this.evaluate(id, now);
    if (verdict === "promote") this.dag.setStatus(id, "active", now);
    if (verdict === "demote") this.dag.setStatus(id, "dormant", now);
    return verdict === "pending" ? null : verdict;
  }

  /** Evaluate every shadow node; returns promoted and demoted id lists. */
  runPromotions(now: Date = new Date()): {
    promoted: string[];
    demoted: string[];
  } {
    const promoted: string[] = [];
    const demoted: string[] = [];
    for (const node of this.dag.listNodes("shadow")) {
      const applied = this.applyVerdict(node.id, now);
      if (applied === "promote") promoted.push(node.id);
      if (applied === "demote") demoted.push(node.id);
    }
    return { promoted, demoted };
  }
}
