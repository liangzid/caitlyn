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
import type { Model } from "@earendil-works/pi-ai";
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
      for (const m of getModels(p)) {
        if (m.id === config.model) return m;
      }
      // Provider found but model not — break to error
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
