/**
 * CAITLYN configured LLM runtime.
 *
 * Centralizes model resolution, persisted credential injection, and the
 * lightweight connection check shared by the CLI, setup wizard, and hooks.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { CaitlynAgentConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { buildCredentialEnv, getCredentialEnv } from "./config/credentials.js";
import { resolveModel } from "./llm.js";
import type { LlmCallFn } from "./scanner.js";

/** Build a scanner-compatible LLM function from active CAITLYN settings. */
export function createConfiguredLlmCall(
  config: CaitlynAgentConfig = loadConfig(),
  apiKey?: string,
): LlmCallFn {
  const model = resolveModel(config);
  const credentialEnv = apiKey
    ? buildCredentialEnv(config.provider, apiKey)
    : getCredentialEnv(config.provider);

  return async (systemPrompt: string, userPrompt: string) => {
    const context = {
      systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: userPrompt }],
          timestamp: Date.now(),
        },
      ],
    };
    const response = await complete(
      model,
      context,
      credentialEnv ? { env: credentialEnv } : undefined,
    );
    return response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  };
}

/** Verify provider credentials with a short, bounded real API request. */
export async function verifyConfiguredLlm(
  config: CaitlynAgentConfig,
  apiKey?: string,
  timeoutMs = 15_000,
): Promise<string> {
  const llmCall = createConfiguredLlmCall(config, apiKey);
  return Promise.race([
    llmCall("Reply with exactly OK.", "Connection check"),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`connection check timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}
