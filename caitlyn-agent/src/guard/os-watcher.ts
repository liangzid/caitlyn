/**
 * CAITLYN Guard — OS Watcher
 *
 * Lightweight host observer: occupancy + /proc/net into ACE-style
 * energy, then detect-only decisions. Quarantine/rollback of OS
 * objects is not implemented. Synthesis is the wrong response for
 * occupancy spikes.
 *
 * KEYPOINT FOR 团长 REVIEW: first version never kills a process and
 * never auto-synthesizes a defense skill from CPU/net energy.
 */

import { collectNetworkMetrics } from "../evolution/network-probe.js";
import type { StatsEvent } from "../evolution/stats-collector.js";
import {
  collectOccupancyMetrics,
  readProcFile,
  type CpuStat,
  type OccupancyFeatures,
  type ProcFileReader,
} from "./os-occupancy.js";
import {
  DEFAULT_OS_ENERGY_CONFIG,
  OS_NETWORK_KEYS,
  OS_OCCUPANCY_KEYS,
  computeOsEnergy,
  pickOsFeatures,
  updateOsEnergyBaseline,
  type OsEnergyBaseline,
  type OsEnergyConfig,
  type OsFeatureVector,
} from "./os-energy.js";

/** ACE-style intervention modes. Component grafts use ACE quarantine. */
export type OsWatchIntervention = "none" | "detect";

export interface OsChannelEnergies {
  occupancy: number;
  network: number;
}

export interface OsWatchTick {
  at: string;
  features: OsFeatureVector;
  energy: number;
  channels: OsChannelEnergies;
  intervention: OsWatchIntervention;
  events: StatsEvent[];
  /** True after minSamples, when energy may fire. */
  calibrated: boolean;
  /** Wall time of this poll in microseconds. */
  tickUs: number;
}

export interface OsWatcherConfig extends OsEnergyConfig {
  reader?: ProcFileReader;
}

/**
 * OS telemetry sources go to detect-only. Agent-behavior anomalies
 * may still enter System II synthesis.
 */
export function isOsTelemetrySource(source: string): boolean {
  return (
    source === "os_network" ||
    source === "os_occupancy" ||
    source === "agent_component"
  );
}

/**
 * Stateful watcher: CPU deltas need the previous /proc/stat sample.
 */
export class OsWatcher {
  private config: OsEnergyConfig;
  private reader: ProcFileReader;
  private prevCpu: CpuStat | null = null;
  private baseline: OsEnergyBaseline = { ewma: {}, sampleCount: 0 };
  private lastTick: OsWatchTick | null = null;

  constructor(config: Partial<OsWatcherConfig> = {}) {
    this.config = { ...DEFAULT_OS_ENERGY_CONFIG, ...config };
    this.reader = config.reader ?? readProcFile;
  }

  /** Most recent tick, or null before the first poll. */
  getLastTick(): OsWatchTick | null {
    return this.lastTick;
  }

  /**
   * One poll: occupancy + network, energy vs EWMA, detect-only if hot.
   */
  tick(now: Date = new Date()): OsWatchTick {
    const t0 = process.hrtime.bigint();
    const at = now.toISOString();
    const occupancy = collectOccupancyMetrics(this.reader, this.prevCpu, at);
    this.prevCpu = occupancy.cpu ?? this.prevCpu;

    const netEvents = collectNetworkMetrics(this.reader, at);
    const features = mergeNetworkFeatures(occupancy.features, netEvents);
    const energy = computeOsEnergy(features, this.baseline.ewma);
    const channels: OsChannelEnergies = {
      occupancy: computeOsEnergy(
        pickOsFeatures(features, OS_OCCUPANCY_KEYS),
        pickOsFeatures(this.baseline.ewma, OS_OCCUPANCY_KEYS),
      ),
      network: computeOsEnergy(
        pickOsFeatures(features, OS_NETWORK_KEYS),
        pickOsFeatures(this.baseline.ewma, OS_NETWORK_KEYS),
      ),
    };
    this.baseline = updateOsEnergyBaseline(
      this.baseline,
      features,
      this.config.ewmaAlpha,
    );

    const calibrated = this.baseline.sampleCount > this.config.minSamples;
    const intervention: OsWatchIntervention =
      calibrated && energy >= this.config.energyThreshold ? "detect" : "none";

    const tick: OsWatchTick = {
      at,
      features,
      energy,
      channels,
      intervention,
      events: [...occupancy.events, ...netEvents],
      calibrated,
      tickUs: Number(process.hrtime.bigint() - t0) / 1000,
    };
    this.lastTick = tick;
    return tick;
  }
}

/**
 * Fold tcp/udp socket counts from os_network events into the energy vector.
 */
export function mergeNetworkFeatures(
  occupancy: OccupancyFeatures,
  netEvents: StatsEvent[],
): OsFeatureVector {
  const features: OsFeatureVector = { ...occupancy };
  let tcpSockets = 0;
  let tcpEstablished = 0;
  let sawSockets = false;
  let sawEstablished = false;
  for (const event of netEvents) {
    if (
      event.metric === "tcp_sockets" ||
      event.metric === "tcp6_sockets" ||
      event.metric === "tcp_inuse" ||
      event.metric === "tcp6_inuse"
    ) {
      tcpSockets += event.value;
      sawSockets = true;
    }
    if (event.metric === "tcp_established" || event.metric === "tcp6_established") {
      tcpEstablished += event.value;
      sawEstablished = true;
    }
  }
  if (sawSockets) features.tcpSockets = tcpSockets;
  if (sawEstablished) features.tcpEstablished = tcpEstablished;
  return features;
}
