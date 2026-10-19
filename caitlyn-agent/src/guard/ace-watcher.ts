/**
 * CAITLYN Guard — ACE component-graph watcher
 *
 * Prototype of Agent Component Energy: first-order mutation count on
 * the mutable skill/MCP/config/command graph. Clean rest is energy 0
 * after the baseline snapshot. Added skill/MCP/command grafts are
 * quarantined when quarantineDir is set.
 *
 * KEYPOINT FOR 团长 REVIEW: threshold is 1 mutable mutation after
 * baseline. Occupancy is a different channel; this one is the paper.
 */

import { getWatchDirsForAgents } from "../adapters/registry.js";
import type { StatsEvent } from "../evolution/stats-collector.js";
import {
  diffComponentGraph,
  inventoryComponentGraph,
  type ComponentGraphDiff,
  type ComponentGraphSnapshot,
} from "./component-graph.js";
import { quarantineGraftedComponents } from "./component-quarantine.js";

export interface AceWatchTick {
  at: string;
  energy: number;
  nodeCount: number;
  mutationCount: number;
  intervention: "none" | "detect";
  calibrated: boolean;
  events: StatsEvent[];
  diff: ComponentGraphDiff;
  roots: string[];
  quarantined: string[];
  tickUs: number;
}

export interface AceWatcherConfig {
  roots?: string[];
  energyThreshold: number;
  /** When set, newly added skill/MCP/command files are moved here. */
  quarantineDir?: string;
}

export const DEFAULT_ACE_WATCHER_CONFIG: AceWatcherConfig = {
  energyThreshold: 1,
};

/**
 * Resolve component roots: explicit list, else installed agent dirs.
 */
export function resolveComponentRoots(explicit?: string[]): string[] {
  if (explicit !== undefined) return explicit;
  return getWatchDirsForAgents().dirs;
}

/**
 * Stateful ACE watcher. First tick records baseline and never alerts.
 */
export class AceWatcher {
  private config: AceWatcherConfig;
  private previous: ComponentGraphSnapshot | null = null;
  private lastTick: AceWatchTick | null = null;

  constructor(config: Partial<AceWatcherConfig> = {}) {
    this.config = { ...DEFAULT_ACE_WATCHER_CONFIG, ...config };
  }

  getLastTick(): AceWatchTick | null {
    return this.lastTick;
  }

  /** Inventory current roots and compare to the previous snapshot. */
  tick(now: Date = new Date()): AceWatchTick {
    const t0 = process.hrtime.bigint();
    const at = now.toISOString();
    const roots = resolveComponentRoots(this.config.roots);
    let current = inventoryComponentGraph(roots);
    const diff = diffComponentGraph(this.previous, current);
    const calibrated = this.previous !== null;
    const intervention =
      calibrated && diff.energy >= this.config.energyThreshold ? "detect" : "none";
    let quarantined: string[] = [];
    if (calibrated && this.config.quarantineDir) {
      quarantined = quarantineGraftedComponents(
        diff.added,
        this.config.quarantineDir,
      );
      if (quarantined.length > 0) {
        current = inventoryComponentGraph(roots);
      }
    }
    this.previous = current;
    const events: StatsEvent[] = [
      {
        source: "agent_component",
        metric: "component_nodes",
        value: current.nodes.size,
        at,
      },
      {
        source: "agent_component",
        metric: "component_mutations",
        value: diff.energy,
        at,
      },
    ];
    const tick: AceWatchTick = {
      at,
      energy: diff.energy,
      nodeCount: current.nodes.size,
      mutationCount: diff.added.length + diff.removed.length + diff.changed.length,
      intervention,
      calibrated,
      events,
      diff,
      roots,
      quarantined,
      tickUs: Number(process.hrtime.bigint() - t0) / 1000,
    };
    this.lastTick = tick;
    return tick;
  }
}
