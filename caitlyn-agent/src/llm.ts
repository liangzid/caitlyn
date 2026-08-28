/**
 * CAITLYN Agent — LLM Provider Setup
 *
 * Registers pi-ai's built-in providers. Users configure provider and model
 * via CAITLYN_PROVIDER / CAITLYN_MODEL env vars (default: openrouter).
 *
 * Each provider reads its API key from its standard env var
 * (e.g. OPENROUTER_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY).
 */

import {
  registerBuiltInApiProviders,
  getProviders,
  getModels,
} from "@earendil-works/pi-ai/compat";
import type { KnownProvider, Model } from "@earendil-works/pi-ai";
import type { CaitlynAgentConfig } from "./config.js";

// Register all built-in providers once at module load so streamSimple
// can resolve auth for any provider.
registerBuiltInApiProviders();

export { getProviders, getModels };

export function resolveModel(config: CaitlynAgentConfig): Model<any> {
  // Validate the user's provider string against the known provider list.
  // `getProviders()` returns KnownProvider[]; matching against it proves
  // that config.provider is a valid KnownProvider for getModels(…).
  for (const p of getProviders()) {
    if (p === config.provider) {
      // KEYPOINT-REVIEW: Table 3 external backbones run through the
      // AICodeMirror relay. The relay exposes Claude via the Claude Code
      // channel, GPT via the Codex Responses API, and Gemini via the
      // standard v1beta paths. Each needs an explicit baseUrl override
      // even when the bundled pi-ai catalog already knows the model id.
      if (AICODEMIRROR_RELAY_BASE_URLS[p] && AICODEMIRROR_RELAY_MODELS.has(config.model)) {
        return makeRelayPassthroughModel(p, config.model);
      }
      for (const m of getModels(p)) {
        if (m.id === config.model) return m;
      }
      // KEYPOINT: Table 4 uses OpenRouter slugs (qwen3.8-max, glm-5.3,
      // kimi-k3) that may be newer than the bundled pi-ai catalog.
      // OpenRouter accepts any slug, so clone a catalog template.
      if (p === "openrouter") {
        return makeOpenRouterPassthroughModel(config.model);
      }
      break;
    }
  }

  const available = getProviders()
    .map((p) => `  ${p}: ${getModels(p).map((m) => m.id).join(", ")}`)
    .join("\n");
  throw new Error(
    `Model "${config.model}" not found for provider "${config.provider}".\n` +
    `Available providers and models:\n${available}`
  );
}

function makeOpenRouterPassthroughModel(modelId: string): Model<any> {
  const catalog = getModels("openrouter");
  const template =
    catalog.find((m) => m.id === "deepseek/deepseek-v4-flash") ?? catalog[0];
  if (!template) {
    throw new Error("OpenRouter catalog is empty; cannot passthrough model id");
  }
  return { ...template, id: modelId, name: modelId };
}

// AICodeMirror relay endpoints used by Table 3 (LLM API comparison).
// The Anthropic endpoint is the Claude Code channel base (the SDK appends
// /v1/messages), the OpenAI endpoint is the Codex Responses API v1 root,
// and the Gemini endpoint already includes the v1beta version segment.
const AICODEMIRROR_RELAY_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.aicodemirror.ai/api/claudecode",
  openai: "https://api.aicodemirror.ai/api/codex/backend-api/codex/v1",
  google: "https://api.aicodemirror.ai/api/gemini/v1beta",
};

// Restricted external models bought from the AICodeMirror relay.
const AICODEMIRROR_RELAY_MODELS = new Set([
  "claude-opus-4-6",
  "claude-fable-5",
  "gpt-5.6-sol",
  "gemini-3.5-flash",
  "gemini-3.7-flash",
]);

function makeRelayPassthroughModel(
  provider: KnownProvider,
  modelId: string,
): Model<any> {
  // Clone a catalog template so context limits, reasoning flags, and
  // tool-call plumbing stay sane, then override the relay base URL.
  const template = getModels(provider)[0];
  if (!template) {
    throw new Error(
      `Provider "${provider}" has no catalog template for relay passthrough`
    );
  }
  return {
    ...template,
    id: modelId,
    name: modelId,
    baseUrl: AICODEMIRROR_RELAY_BASE_URLS[provider],
  };
}
