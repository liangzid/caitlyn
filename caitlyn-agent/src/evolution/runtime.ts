/**
 * CAITLYN Evolution — Scan-Time Runtime
 *
 * Lightweight integration used by the scanning pipeline: every scanned
 * content is recorded against shadow antibodies (record-only), and
 * promotion windows are evaluated after each scan batch.
 */

import { loadEvolutionConfig } from "../config.js";
import { AntibodyDagStore } from "./dag-store.js";
import { dagPolicyFrom } from "./engine.js";
import { ShadowManager } from "./shadow.js";

/**
 * Record one scan against every shadow antibody and run promotions.
 * Never throws: evolution state problems must not break scanning.
 */
export function recordShadowScans(content: string): void {
  try {
    const config = loadEvolutionConfig();
    if (config.autonomy === "record") return;
    const dag = new AntibodyDagStore(config.evolutionDir, dagPolicyFrom(config));
    dag.load();
    const shadowNodes = dag.listNodes("shadow");
    if (shadowNodes.length === 0) return;

    const manager = new ShadowManager(dag, {
      shadowWindowDays: config.shadowWindowDays,
      shadowMinScans: config.shadowMinScans,
    });
    for (const node of shadowNodes) {
      manager.recordScan(node.id, content);
    }
    manager.runPromotions();
    dag.save();
  } catch {
    // Evolution state unavailable — scanning continues unaffected.
  }
}
