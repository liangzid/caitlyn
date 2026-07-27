/**
 * CAITLYN Evolution — Affinity Maturation
 *
 * Evaluates antibody candidates against a validation set.
 * Computes precision/recall/F1 and selects top survivors.
 *
 * Mirrors src/evolution/affinity.rs.
 */
import type {
  AffinityConfig,
  AffinityResult,
  Antibody,
  LabeledSample,
} from "./types.js";

const DEFAULT_CONFIG: AffinityConfig = {
  recallWeight: 0.7,
  precisionWeight: 0.3,
  fpPenalty: 0.2,
  survivalThreshold: 0.6,
  maxSurvivors: 3,
};

export class AffinityMaturation {
  private config: AffinityConfig;

  constructor(config: Partial<AffinityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluate candidates against labeled samples.
   *
   * `mustDetect` — attacks that MUST be detected (hard constraint).
   * `shouldDetect` — similar attacks (soft, improves recall).
   * `mustNotDetect` — benign (hard constraint — damages precision if flagged).
   *
   * `scanner` — function that simulates the antibody: (prompt, content) → [isMalicious, confidence]
   */
  evaluate(
    candidates: Antibody[],
    mustDetect: LabeledSample[],
    shouldDetect: LabeledSample[],
    mustNotDetect: LabeledSample[],
    scanner: (prompt: string, content: string) => Promise<[boolean, number]>,
  ): Promise<AffinityResult[]> {
    return Promise.all(
      candidates.map(async (candidate) => {
        let tp = 0;
        let fp = 0;
        let tn = 0;
        let fn = 0;

        // Test must-detect samples (hard constraint)
        for (const sample of mustDetect) {
          const [isMalicious] = await scanner(candidate.prompt, sample.content);
          if (isMalicious) tp++;
          else fn++;
        }

        // Test should-detect samples (soft)
        for (const sample of shouldDetect) {
          const [isMalicious] = await scanner(candidate.prompt, sample.content);
          if (isMalicious) tp++;
          else fn++;
        }

        // Test must-not-detect samples (hard constraint)
        for (const sample of mustNotDetect) {
          const [isMalicious] = await scanner(candidate.prompt, sample.content);
          if (isMalicious) fp++;
          else tn++;
        }

        const totalDetections = tp + fp;
        const precision = totalDetections > 0 ? tp / totalDetections : 0;
        const recall = tp + fn > 0 ? tp / (tp + fn) : 0;

        const affinityScore =
          recall * this.config.recallWeight +
          precision * this.config.precisionWeight -
          (fp / (fp + tn + 1)) * this.config.fpPenalty;

        const detectedMustDetect = fn === 0 || mustDetect.length === 0
          ? mustDetect.length > 0
            ? tp >= mustDetect.length
            : true
          : false;

        return {
          antibody: { ...candidate, stats: { ...candidate.stats, precision, recall } },
          truePositives: tp,
          falsePositives: fp,
          trueNegatives: tn,
          falseNegatives: fn,
          affinityScore,
          detectedMustDetect,
        };
      }),
    );
  }

  /** Select surviving antibodies: must pass hard constraints + survival threshold. */
  selectSurvivors(results: AffinityResult[]): AffinityResult[] {
    return results
      .filter((r) => r.detectedMustDetect)
      .filter((r) => r.affinityScore >= this.config.survivalThreshold)
      .sort((a, b) => b.affinityScore - a.affinityScore)
      .slice(0, this.config.maxSurvivors);
  }
}
