/**
 * CAITLYN LLM catalog compatibility tests.
 */

import { describe, expect, it } from "vitest";
import { getModels, resolveModel } from "../src/llm.js";

describe("resolveModel", () => {
  it("preserves saved xAI models omitted by the bundled catalog", () => {
    const model = resolveModel({
      provider: "xai",
      model: "grok-4.20-0309-reasoning",
      smallModel: "grok-4.20-0309-reasoning",
    });

    expect(model.provider).toBe("xai");
    expect(model.id).toBe("grok-4.20-0309-reasoning");
    expect(model.baseUrl).toBe("https://api.x.ai/v1");
  });

  it("preserves retired xAI aliases through their serving model shape", () => {
    const grok3 = resolveModel({
      provider: "xai",
      model: "grok-3",
      smallModel: "grok-3",
    });
    const codeFast = resolveModel({
      provider: "xai",
      model: "grok-code-fast-1",
      smallModel: "grok-code-fast-1",
    });

    expect(grok3.id).toBe("grok-3");
    expect(grok3.api).toBe("openai-completions");
    expect(codeFast.id).toBe("grok-code-fast-1");
    expect(codeFast.api).toBe("openai-completions");
  });

  it("rejects xAI models whose tool capabilities cannot be inferred", () => {
    expect(() => resolveModel({
      provider: "xai",
      model: "grok-4.20-multi-agent",
      smallModel: "grok-4.20-multi-agent",
    })).toThrow('Model "grok-4.20-multi-agent" not found');
  });
});

describe("getModels", () => {
  it("keeps ordinary OpenAI chat models visible", () => {
    expect(getModels("openai").some((model) => model.id === "gpt-5.4-mini")).toBe(true);
  });

  it("hides realtime-only OpenAI models from chat selection", () => {
    expect(getModels("openai").some((model) => model.id === "gpt-realtime-2.1")).toBe(false);
  });
});
