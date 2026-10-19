/**
 * CAITLYN Guard — Host steward
 *
 * Fuses occupancy, network, and ACE component channels into one
 * 管家-style detect-only decision. Writes incidents to jsonl.
 * Does not kill processes or synthesize skills from these channels.
 *
 * KEYPOINT FOR 团长 REVIEW: fusion is OR across hot channels, not a
 * weighted mix. A Möbius graft can fire with quiet occupancy.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { StatsEvent } from "../evolution/stats-collector.js";
import { AceWatcher, type AceWatchTick } from "./ace-watcher.js";
import { DEFAULT_OS_ENERGY_CONFIG } from "./os-energy.js";
import { OsWatcher, type OsWatchTick } from "./os-watcher.js";

export type HostChannelName = "occupancy" | "network" | "component";

export interface HostChannelScores {
  occupancy: number;
  network: number;
  component: number;
}

export interface HostWatchSnapshot {
  at: string;
  energy: number;
  channels: HostChannelScores;
  hotChannels: HostChannelName[];
  intervention: "none" | "detect";
  calibrated: boolean;
  events: StatsEvent[];
  os: OsWatchTick;
  ace: AceWatchTick;
  tickUs: number;
}

/** Wire-safe snapshot: no event arrays, no full component node lists. */
export interface PublicHostWatchSnapshot {
  at: string;
  energy: number;
  channels: HostChannelScores;
  hotChannels: HostChannelName[];
  intervention: "none" | "detect";
  calibrated: boolean;
  tickUs: number;
  os: {
    features: OsWatchTick["features"];
    energy: number;
    channels: OsWatchTick["channels"];
    intervention: OsWatchTick["intervention"];
    calibrated: boolean;
    tickUs: number;
  };
  ace: {
    energy: number;
    nodeCount: number;
    mutationCount: number;
    intervention: AceWatchTick["intervention"];
    calibrated: boolean;
    roots: string[];
    quarantined: string[];
    tickUs: number;
  };
}

/** Drop heavy fields before HTTP. */
export function toPublicHostSnapshot(
  snapshot: HostWatchSnapshot,
): PublicHostWatchSnapshot {
  return {
    at: snapshot.at,
    energy: snapshot.energy,
    channels: snapshot.channels,
    hotChannels: snapshot.hotChannels,
    intervention: snapshot.intervention,
    calibrated: snapshot.calibrated,
    tickUs: snapshot.tickUs,
    os: {
      features: snapshot.os.features,
      energy: snapshot.os.energy,
      channels: snapshot.os.channels,
      intervention: snapshot.os.intervention,
      calibrated: snapshot.os.calibrated,
      tickUs: snapshot.os.tickUs,
    },
    ace: {
      energy: snapshot.ace.energy,
      nodeCount: snapshot.ace.nodeCount,
      mutationCount: snapshot.ace.mutationCount,
      intervention: snapshot.ace.intervention,
      calibrated: snapshot.ace.calibrated,
      roots: snapshot.ace.roots,
      quarantined: snapshot.ace.quarantined,
      tickUs: snapshot.ace.tickUs,
    },
  };
}

export interface HostIncident {
  at: string;
  intervention: "detect";
  hotChannels: HostChannelName[];
  channels: HostChannelScores;
}

export interface HostStewardConfig {
  statsDir?: string;
  osWatcher?: OsWatcher;
  aceWatcher?: AceWatcher;
  occupancyThreshold: number;
  networkThreshold: number;
}

export const DEFAULT_HOST_STEWARD_CONFIG: HostStewardConfig = {
  occupancyThreshold: DEFAULT_OS_ENERGY_CONFIG.energyThreshold,
  networkThreshold: DEFAULT_OS_ENERGY_CONFIG.energyThreshold,
};

/**
 * Decide which channels are hot. Component uses ACE's own intervention.
 */
export function fuseHostChannels(
  os: OsWatchTick,
  ace: AceWatchTick,
  occupancyThreshold: number,
  networkThreshold: number,
): { hotChannels: HostChannelName[]; intervention: "none" | "detect" } {
  const hotChannels: HostChannelName[] = [];
  if (os.calibrated && os.channels.occupancy >= occupancyThreshold) {
    hotChannels.push("occupancy");
  }
  if (os.calibrated && os.channels.network >= networkThreshold) {
    hotChannels.push("network");
  }
  if (ace.intervention === "detect") hotChannels.push("component");
  return {
    hotChannels,
    intervention: hotChannels.length > 0 ? "detect" : "none",
  };
}

/**
 * Dual-channel steward: OS watcher + ACE watcher.
 */
export class HostSteward {
  private osWatcher: OsWatcher;
  private aceWatcher: AceWatcher;
  private occupancyThreshold: number;
  private networkThreshold: number;
  private statsDir: string | null;
  private lastSnapshot: HostWatchSnapshot | null = null;

  constructor(config: Partial<HostStewardConfig> = {}) {
    const merged = { ...DEFAULT_HOST_STEWARD_CONFIG, ...config };
    this.osWatcher = config.osWatcher ?? new OsWatcher();
    this.aceWatcher = config.aceWatcher ?? new AceWatcher();
    this.occupancyThreshold = merged.occupancyThreshold;
    this.networkThreshold = merged.networkThreshold;
    this.statsDir = merged.statsDir ?? null;
  }

  getLastSnapshot(): HostWatchSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * Poll occupancy always. Inventory the component graph only when
   * includeAce is true, or on the first tick so fusion has a baseline.
   * Occupancy-only ticks omit ACE events from the jsonl stream.
   */
  tick(now: Date = new Date(), includeAce: boolean = true): HostWatchSnapshot {
    const os = this.osWatcher.tick(now);
    const runAce = includeAce || this.aceWatcher.getLastTick() === null;
    const ace = runAce
      ? this.aceWatcher.tick(now)
      : this.aceWatcher.getLastTick()!;
    const { hotChannels, intervention } = fuseHostChannels(
      os,
      ace,
      this.occupancyThreshold,
      this.networkThreshold,
    );
    const channels: HostChannelScores = {
      occupancy: os.channels.occupancy,
      network: os.channels.network,
      component: ace.energy,
    };
    const snapshot: HostWatchSnapshot = {
      at: now.toISOString(),
      energy: Math.max(channels.occupancy, channels.network, channels.component),
      channels,
      hotChannels,
      intervention,
      calibrated: os.calibrated || ace.calibrated,
      events: runAce ? [...os.events, ...ace.events] : os.events,
      os,
      ace,
      tickUs: os.tickUs + (runAce ? ace.tickUs : 0),
    };
    this.lastSnapshot = snapshot;
    if (intervention === "detect") {
      this.writeIncident({
        at: snapshot.at,
        intervention: "detect",
        hotChannels,
        channels,
      });
    }
    return snapshot;
  }

  private writeIncident(incident: HostIncident): void {
    if (!this.statsDir) return;
    try {
      fs.mkdirSync(this.statsDir, { recursive: true });
      const file = path.join(this.statsDir, "host-incidents.jsonl");
      fs.appendFileSync(file, `${JSON.stringify(incident)}\n`, "utf-8");
    } catch {
      // Steward must not crash the daemon on disk errors.
    }
  }
}
