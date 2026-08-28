/**
 * CAITLYN — Local verification before packing a contribution.
 *
 * Defenses: hard gate (schema already loaded + ReDoS + regex compile).
 * Antigens: soft warnings only.
 */

import { isDangerousRegex, VerificationSandbox } from "../evolution/verifier.js";
import type { AntibodyEntry, AntigenEntry } from "../schema.js";

export interface DefenseVerifyResult {
  ok: boolean;
  errors: string[];
}

export interface AntigenVerifyResult {
  warnings: string[];
}

/**
 * Hard-gate a defense skill for contribution.
 * Rejects dangerous or uncompilable regex signatures; requires an implementation artifact.
 */
export async function verifyDefenseForContribute(
  entry: AntibodyEntry,
  regexTimeoutMs = 200,
): Promise<DefenseVerifyResult> {
  const errors: string[] = [];
  const hasScript = Boolean(entry.scriptPath);
  const hasPrompt = entry.config.prompt.trim().length > 0;
  const hasSignatures = entry.config.signatures.length > 0;

  if (!entry.readme.trim()) {
    errors.push("missing or empty README.md");
  }
  if (entry.config.execution_stages.length === 0) {
    errors.push("execution_stages must not be empty");
  }
  if (entry.config.implementation_status === "reference") {
    if (entry.config.references.length === 0) {
      errors.push("reference skill without a source");
    }
    if (entry.config.runtime_requirements.length === 0) {
      errors.push("reference skill without runtime_requirements");
    }
    return { ok: errors.length === 0, errors };
  }

  if (entry.config.role === "detector") {
    if (entry.config.tier === 0 && !hasScript && !hasSignatures) {
      errors.push("tier 0 detector without detect.ts or signatures");
    }
    if (entry.config.tier > 0 && !hasPrompt) {
      errors.push(`tier ${entry.config.tier} detector without prompt`);
    }
  } else if (!hasPrompt && !hasScript && !hasSignatures) {
    errors.push("non-detector without prompt/script/signatures");
  }

  for (const sig of entry.config.signatures) {
    if (sig.type === "regex" && isDangerousRegex(sig.pattern)) {
      errors.push(`dangerous regex rejected: ${sig.label || sig.pattern}`);
    }
  }

  if (hasSignatures && errors.length === 0) {
    const sandbox = new VerificationSandbox({
      benignSamples: 0,
      maxBenignFalsePositives: 0,
      regexTimeoutMs,
    });
    // Empty sample sets still exercise compile + timeout path in the worker.
    const outcome = await sandbox.verify(entry.config.signatures, [], []);
    for (const err of outcome.errors) {
      errors.push(err);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Soft-warn antigens; never blocks packing by itself. */
export function verifyAntigenForContribute(entry: AntigenEntry): AntigenVerifyResult {
  const warnings: string[] = [];
  if (!entry.payload.trim()) {
    warnings.push("empty payload.txt");
  }
  if (!entry.readme.trim()) {
    warnings.push("empty README.md");
  }
  return { warnings };
}
