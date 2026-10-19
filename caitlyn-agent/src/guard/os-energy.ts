/**
 * CAITLYN Guard — OS-graph energy (ACE analog)
 *
 * ACE (arxiv:2605.11442) measures first-order mutation energy on the
 * agent component graph. This module uses the same comparison shape on
 * an OS feature vector: excess over a clean EWMA baseline, summed
 * across occupancy and network vertices.
 *
 * KEYPOINT FOR 团长 REVIEW: occupancy energy is complementary to ACE.
 * A stealth Möbius loop can sit below benign HTTP rate. Do not treat
 * a quiet network as a clean agent.
 */

/** Named OS vertices that contribute to energy. */
export interface OsFeatureVector {
  load1?: number;
  cpuBusy?: number;
  memUsedRatio?: number;
  processes?: number;
  tcpSockets?: number;
  tcpEstablished?: number;
}

export interface OsEnergyBaseline {
  ewma: OsFeatureVector;
  sampleCount: number;
}

export interface OsEnergyConfig {
  /** EWMA weight on the newest sample. */
  ewmaAlpha: number;
  /** Samples required before detect-only may fire. */
  minSamples: number;
  /** Alert when summed excess exceeds this value. */
  energyThreshold: number;
}

export const DEFAULT_OS_ENERGY_CONFIG: OsEnergyConfig = {
  ewmaAlpha: 0.2,
  minSamples: 2,
  energyThreshold: 3,
};

const COUNT_FLOOR = 1;
const RATIO_FLOOR = 0.05;

export const OS_OCCUPANCY_KEYS: Array<keyof OsFeatureVector> = [
  "load1",
  "cpuBusy",
  "memUsedRatio",
  "processes",
];

export const OS_NETWORK_KEYS: Array<keyof OsFeatureVector> = [
  "tcpSockets",
  "tcpEstablished",
];

/** Keep only the named coordinates. */
export function pickOsFeatures(
  vector: OsFeatureVector,
  keys: Array<keyof OsFeatureVector>,
): OsFeatureVector {
  const out: OsFeatureVector = {};
  for (const key of keys) {
    const value = vector[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * First-order excess energy: sum_i max(0, (x_i - b_i) / max(b_i, floor)).
 * Missing current or baseline coordinates contribute 0.
 */
export function computeOsEnergy(
  current: OsFeatureVector,
  baseline: OsFeatureVector,
): number {
  let energy = 0;
  for (const key of Object.keys(current) as Array<keyof OsFeatureVector>) {
    const x = current[key];
    const b = baseline[key];
    if (x === undefined || b === undefined) continue;
    const floor = isRatioFeature(key) ? RATIO_FLOOR : COUNT_FLOOR;
    const denom = Math.max(b, floor);
    energy += Math.max(0, (x - b) / denom);
  }
  return energy;
}

/**
 * Update EWMA coordinates that are present on the sample. Unseen keys
 * stay unset until the first observation.
 */
export function updateOsEnergyBaseline(
  baseline: OsEnergyBaseline,
  sample: OsFeatureVector,
  alpha: number,
): OsEnergyBaseline {
  const ewma: OsFeatureVector = { ...baseline.ewma };
  for (const key of Object.keys(sample) as Array<keyof OsFeatureVector>) {
    const x = sample[key];
    if (x === undefined) continue;
    const prev = ewma[key];
    ewma[key] = prev === undefined ? x : alpha * x + (1 - alpha) * prev;
  }
  return { ewma, sampleCount: baseline.sampleCount + 1 };
}

function isRatioFeature(key: keyof OsFeatureVector): boolean {
  return key === "cpuBusy" || key === "memUsedRatio";
}
