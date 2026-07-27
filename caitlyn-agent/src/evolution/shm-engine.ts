/**
 * CAITLYN Evolution — SHM Engine
 *
 * Somatic Hypermutation: uses LLM to generate semantic variants
 * of a parent antibody. Adaptive temperature adjusts based on
 * success/failure history.
 *
 * Mirrors src/evolution/shm.rs.
 */
import type { LlmCallFn } from "../scanner.js";
import type { Antibody, ShmVariant } from "./types.js";

const TEMPERATURE_MIN = 0.3;
const TEMPERATURE_MAX = 0.95;
const TEMPERATURE_STEP = 0.1;

function buildShmSystemPrompt(parent: Antibody, temperature: number): string {
  return `You are an expert at evolving AI defense systems through semantic mutation.
Your task is to create variants of a defense antibody that detect a specific attack pattern.

## Parent Antibody
Name: ${parent.name}
Description: ${parent.description}
Category: ${parent.category}
Tier: ${parent.tier}
Current Prompt:
---
${parent.prompt}
---
Current threshold: ${parent.threshold}

## Mutation Guidelines
Temperature = ${temperature.toFixed(2)} (0.0=conservative, 1.0=radical)

Available mutation operations:
1. PROMPT_REPHRASE: Rewrite detection instructions with different framing
2. HEURISTIC_ADD: Add new detection patterns/heuristics
3. HEURISTIC_PRUNE: Remove redundant or noisy patterns
4. THRESHOLD_TUNE: Adjust confidence threshold
5. SCOPE_EXPAND: Broaden to cover related attack variants
6. SCOPE_NARROW: Narrow to reduce false positive surface
7. SIGNATURE_EXTRACT: Identify exact/regex patterns for fast-path matching

Each variant MUST:
- Be structurally valid (name, description, prompt, threshold)
- Be semantically different from siblings
- Still detect the parent's attack category
- Target Tier 1 (Specialized) — fast, single LLM call, no tools

Output as a JSON array of antibody objects.`;
}

function buildShmUserPrompt(
  parent: Antibody,
  antigenSamples: string[],
  nVariants: number,
): string {
  const samples = antigenSamples
    .map((s, i) => `### Sample ${i + 1}\n\`\`\`\n${s}\n\`\`\``)
    .join("\n\n");

  return `## Attack Samples That Must Be Detected

${samples}

## Task
Generate exactly ${nVariants} variants of the "${parent.name}" antibody.
Each variant must detect ALL the above attack samples while minimizing false positives.

Output as JSON:
\`\`\`json
[
  {
    "name": "variant name",
    "description": "what this variant detects and how",
    "prompt": "the detection system prompt",
    "threshold": 0.7,
    "mutation_operations": ["PROMPT_REPHRASE", "HEURISTIC_ADD"],
    "new_signatures": ["exact pattern 1"]
  }
]
\`\`\``;
}

/** Extract the first JSON array from a string. */
function extractJsonArray(s: string): string | null {
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

/** Parse LLM output into ShmVariant objects. */
function parseVariants(raw: string): ShmVariant[] {
  const jsonStr = extractJsonArray(raw) ?? raw;
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v: Record<string, unknown>) => ({
      name: String(v.name ?? "unnamed"),
      description: String(v.description ?? ""),
      prompt: String(v.prompt ?? ""),
      threshold: typeof v.threshold === "number" ? v.threshold : 0.7,
      mutationOperations: Array.isArray(v.mutation_operations)
        ? v.mutation_operations.map(String)
        : [],
      newSignatures: Array.isArray(v.new_signatures)
        ? v.new_signatures.map(String)
        : [],
    }));
  } catch {
    return [];
  }
}

export class ShmEngine {
  baseTemperature: number;
  private currentTemperature: number;
  private consecutiveSuccesses = 0;
  private consecutiveFailures = 0;

  constructor(baseTemperature = 0.8) {
    this.baseTemperature = baseTemperature;
    this.currentTemperature = baseTemperature;
  }

  get temperature(): number {
    return this.currentTemperature;
  }

  /** Record a successful vaccination → potentially increase temperature. */
  recordSuccess(): void {
    this.consecutiveSuccesses++;
    this.consecutiveFailures = 0;
    if (this.consecutiveSuccesses >= 3) {
      this.currentTemperature = Math.min(
        this.currentTemperature + TEMPERATURE_STEP,
        TEMPERATURE_MAX,
      );
      this.consecutiveSuccesses = 0;
    }
  }

  /** Record a failed vaccination → decrease temperature. */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    this.currentTemperature = Math.max(
      this.currentTemperature - TEMPERATURE_STEP,
      TEMPERATURE_MIN,
    );
  }

  /** Generate N semantic variants of a parent antibody. */
  async mutate(
    parent: Antibody,
    antigenSamples: string[],
    nVariants: number,
    llmCall: LlmCallFn,
  ): Promise<Antibody[]> {
    const systemPrompt = buildShmSystemPrompt(parent, this.currentTemperature);
    const userPrompt = buildShmUserPrompt(parent, antigenSamples, nVariants);

    const rawOutput = await llmCall(systemPrompt, userPrompt);
    const variants = parseVariants(rawOutput);

    return variants.map((v) => ({
      id: `${parent.id}-v${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: v.name,
      description: v.description,
      category: parent.category,
      tier: 1, // Specialized
      prompt: v.prompt,
      threshold: v.threshold,
      status: "candidate" as const,
      stats: {
        totalScans: 0,
        truePositives: 0,
        falsePositives: 0,
        avgLatencyUs: 0,
      },
    }));
  }
}
