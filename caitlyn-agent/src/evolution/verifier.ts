/**
 * CAITLYN Evolution — Deterministic Verification Sandbox
 *
 * The only trust anchor of the evolution loop. Candidate signatures are
 * executed against the antigen cluster (must detect every sample) and a
 * small set of benign samples (bounded false positives). Regex execution
 * happens in a child process so a pathological pattern can be killed by
 * timeout; obviously dangerous patterns are rejected statically first.
 */

import { spawn } from "node:child_process";

export interface AntibodySignatureLike {
  pattern: string;
  type: string;
  label: string;
}

export interface VerifierConfig {
  benignSamples: number;
  maxBenignFalsePositives: number;
  regexTimeoutMs: number;
}

export interface VerificationOutcome {
  mustDetectPassed: boolean;
  falsePositiveCount: number;
  benignSampleCount: number;
  errors: string[];
}

type SampleKind = "must" | "benign";

interface WorkerInput {
  signatures: Array<{ pattern: string; type: string; label: string }>;
  samples: Array<{ kind: SampleKind; text: string }>;
}

type Hit = Array<[string, SampleKind, string]>;

/**
 * Child-process worker: applies each signature to every sample and emits
 * the hit list as JSON. Regex errors are reported as "__regex_error__".
 */
const WORKER_SCRIPT = `
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  const hits = [];
  for (const sig of input.signatures) {
    if (sig.type === "regex") {
      let re;
      try {
        re = new RegExp(sig.pattern, "i");
      } catch {
        hits.push(["__regex_error__", sig.label, ""]);
        continue;
      }
      for (const sample of input.samples) {
        try {
          if (re.test(sample.text)) hits.push([sig.label || sig.pattern, sample.kind, sample.text]);
        } catch {
          hits.push(["__regex_error__", sig.label, ""]);
        }
      }
    } else {
      for (const sample of input.samples) {
        if (sample.text.includes(sig.pattern)) {
          hits.push([sig.label || sig.pattern, sample.kind, sample.text]);
        }
      }
    }
  }
  process.stdout.write(JSON.stringify(hits));
});
`;

/**
 * Static ReDoS heuristic: nested quantifiers like (a+)+, (a*)*, (a+)* .
 * An outer `?` (optional group) is allowed: patterns such as `(all\s+)?` are
 * common and not catastrophic.
 * Escapes and character classes are replaced with a placeholder (not deleted)
 * so `\s+` does not become a bare `+` glued to the previous group.
 * KEYPOINT-REVIEW: 这是启发式，覆盖已知灾难性回溯模式；未知模式由
 * 子进程超时兜底，但理论上仍存在漏网风险。
 */
export function isDangerousRegex(pattern: string): boolean {
  const stripped = pattern
    .replace(/\\./g, "a")
    .replace(/\[[^\]]*\]/g, "a");
  // Outer quantifier must be + or * (not ?). `(foo+)?` is safe; `(foo+)+` is not.
  return /\([^()]*[+*?][^()]*\)[+*]/.test(stripped);
}

export class VerificationSandbox {
  private config: VerifierConfig;

  constructor(config: VerifierConfig) {
    this.config = config;
  }

  /**
   * Verify a candidate against the antigen cluster and benign samples.
   * mustDetectPassed requires every must-detect sample to be hit.
   * KEYPOINT-REVIEW: 良性样本数由 config.benignSamples 截断；
   * FP 判定只报告数量，是否可接受由调用方按 maxBenignFalsePositives 组合。
   */
  async verify(
    signatures: AntibodySignatureLike[],
    mustDetect: string[],
    benign: string[],
  ): Promise<VerificationOutcome> {
    const errors: string[] = [];
    const usable: AntibodySignatureLike[] = [];

    for (const sig of signatures) {
      if (sig.type === "regex" && isDangerousRegex(sig.pattern)) {
        errors.push(`dangerous regex rejected: ${sig.label}`);
        continue;
      }
      usable.push(sig);
    }

    const benignSlice = benign.slice(0, this.config.benignSamples);
    const samples: Array<{ kind: SampleKind; text: string }> = [
      ...mustDetect.map((text) => ({ kind: "must" as const, text })),
      ...benignSlice.map((text) => ({ kind: "benign" as const, text })),
    ];

    const hits = await this.runWorker({ signatures: usable, samples });
    if (hits === null) {
      errors.push(`regex execution timed out after ${this.config.regexTimeoutMs}ms`);
      return {
        mustDetectPassed: false,
        falsePositiveCount: benignSlice.length,
        benignSampleCount: benignSlice.length,
        errors,
      };
    }

    const mustHits = new Set<string>();
    let falsePositiveCount = 0;
    for (const [label, kind, text] of hits) {
      if (label === "__regex_error__") {
        errors.push(`invalid regex: ${text || "unknown"}`);
        continue;
      }
      if (kind === "must") {
        mustHits.add(text);
      } else {
        falsePositiveCount += 1;
      }
    }

    const mustDetectPassed = mustDetect.every((text) => mustHits.has(text));
    return {
      mustDetectPassed,
      falsePositiveCount,
      benignSampleCount: benignSlice.length,
      errors,
    };
  }

  /** Runs the worker child process; returns null on timeout. */
  private runWorker(input: WorkerInput): Promise<Hit | null> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", WORKER_SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let settled = false;
      const settle = (result: Hit | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle(null);
      }, this.config.regexTimeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      child.on("error", () => settle(null));
      child.on("close", () => {
        if (settled) return;
        try {
          settle(JSON.parse(stdout) as Hit);
        } catch {
          settle(null);
        }
      });
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    });
  }
}
