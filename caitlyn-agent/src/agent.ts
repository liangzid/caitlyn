/**
 * CAITLYN Agent — Core Setup
 *
 * Wires pi Agent with CAITLYN system prompt, tools, and LLM backend.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { loadConfig, type CaitlynAgentConfig } from "./config.js";
import { resolveModel } from "./llm.js";
import { CAITLYN_SYSTEM_PROMPT } from "./system-prompt.js";
import { createCaitlynTools } from "./tools.js";
import type { LlmCallFn } from "./scanner.js";
import type { Model } from "@earendil-works/pi-ai";
import { getCredentialEnv } from "./config/credentials.js";
import { createConfiguredLlmCall } from "./llm-runtime.js";

export interface CaitlynAgentContext {
  agent: Agent;
  config: CaitlynAgentConfig;
  model: Model<any>;
  llmCall: LlmCallFn;
}

export async function createCaitlynAgent(): Promise<CaitlynAgentContext> {
  const config = loadConfig();
  const model = resolveModel(config);
  const credentialEnv = getCredentialEnv(config.provider);
  console.log(`🤖 LLM: ${model.provider}/${model.id}`);

  const llmCall: LlmCallFn = createConfiguredLlmCall(config);

  const tools = createCaitlynTools(llmCall);

  const agent = new Agent({
    initialState: {
      systemPrompt: CAITLYN_SYSTEM_PROMPT,
      tools,
      model,
    },
    streamFn: (selectedModel, context, options) => streamSimple(
      selectedModel,
      context,
      credentialEnv
        ? { ...options, env: { ...options?.env, ...credentialEnv } }
        : options,
    ),
  });

  return { agent, config, model, llmCall };
}
