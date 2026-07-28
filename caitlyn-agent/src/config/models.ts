/**
 * CAITLYN Model Registry
 *
 * Known models with context windows, reasoning support, and input types.
 * Used for token tracking, compaction, and model switching UI.
 */

export interface ModelInfo {
  provider: string;
  model: string;
  display: string;
  contextWindow: number;
  reasoning?: boolean;
  input: Array<"text" | "image" | "audio">;
}

// ── Registry ──────────────────────────────────────────────────────

export const CAITLYN_MODELS: ModelInfo[] = [
  {
    provider: "openrouter",
    model: "deepseek/deepseek-chat",
    display: "DeepSeek V3",
    contextWindow: 128_000,
    input: ["text"],
  },
  {
    provider: "openrouter",
    model: "deepseek/deepseek-r1",
    display: "DeepSeek R1",
    contextWindow: 128_000,
    reasoning: true,
    input: ["text"],
  },
  {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    display: "Claude Sonnet 4",
    contextWindow: 200_000,
    reasoning: true,
    input: ["text"],
  },
  {
    provider: "openrouter",
    model: "anthropic/claude-3.5-sonnet",
    display: "Claude 3.5 Sonnet",
    contextWindow: 200_000,
    input: ["text"],
  },
  {
    provider: "openai",
    model: "gpt-4o",
    display: "GPT-4o",
    contextWindow: 128_000,
    input: ["text", "image"],
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    display: "GPT-4o Mini",
    contextWindow: 128_000,
    input: ["text"],
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    display: "Claude Sonnet 4",
    contextWindow: 200_000,
    reasoning: true,
    input: ["text"],
  },
  {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    display: "Claude 3.5 Sonnet",
    contextWindow: 200_000,
    input: ["text"],
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    display: "DeepSeek V4",
    contextWindow: 128_000,
    input: ["text"],
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    display: "DeepSeek V4 Flash",
    contextWindow: 128_000,
    input: ["text"],
  },
  {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro",
    display: "DeepSeek V4",
    contextWindow: 128_000,
    input: ["text"],
  },
];

/** Look up model info by provider + model id. */
export function lookupModel(
  provider: string,
  modelId: string,
): ModelInfo | undefined {
  return CAITLYN_MODELS.find(
    (m) => m.provider === provider && m.model === modelId,
  );
}

/** Find the context window size for a given provider/model pair. */
export function getContextWindow(
  provider: string,
  modelId: string,
): number {
  return lookupModel(provider, modelId)?.contextWindow ?? 128_000;
}

/** Get display name for a model. */
export function getModelDisplay(
  provider: string,
  modelId: string,
): string {
  return lookupModel(provider, modelId)?.display ?? `${provider}/${modelId}`;
}
