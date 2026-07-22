/**
 * CAITLYN Agent — Core Setup
 *
 * Wires pi Agent with CAITLYN system prompt, tools, and LLM backend.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple, complete } from "@earendil-works/pi-ai/compat";
import { loadConfig, type CaitlynAgentConfig } from "./config.js";
import { resolveModel } from "./llm.js";
import { CAITLYN_SYSTEM_PROMPT } from "./system-prompt.js";
import { createCaitlynTools } from "./tools.js";
import type { LlmCallFn } from "./scanner.js";
import type { Model } from "@earendil-works/pi-ai";

export interface CaitlynAgentContext {
  agent: Agent;
  config: CaitlynAgentConfig;
  model: Model<any>;
  llmCall: LlmCallFn;
}

export async function createCaitlynAgent(): Promise<CaitlynAgentContext> {
  const config = loadConfig();
  const model = resolveModel(config);
  console.log(`🤖 LLM: ${model.provider}/${model.id}`);

  const llmCall: LlmCallFn = async (systemPrompt: string, userPrompt: string) => {
    const ctx = {
      systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: userPrompt }],
          timestamp: Date.now(),
        },
      ],
    };
    const response = await complete(model, ctx);
    const textBlocks = response.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    return textBlocks.map((c) => c.text).join("");
  };

  const tools = createCaitlynTools(llmCall);

  const agent = new Agent({
    initialState: {
      systemPrompt: CAITLYN_SYSTEM_PROMPT,
      tools,
      model,
    },
    streamFn: streamSimple,
  });

  return { agent, config, model, llmCall };
}
