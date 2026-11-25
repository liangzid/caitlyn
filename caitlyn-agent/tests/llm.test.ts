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

  it("uses the Responses API for xAI multi-agent passthrough models", () => {
    const model = resolveModel({
      provider: "xai",
      model: "grok-4.20-multi-agent",
      smallModel: "grok-4.20-multi-agent",
    });

    expect(model.provider).toBe("xai");
    expect(model.id).toBe("grok-4.20-multi-agent");
    expect(model.api).toBe("openai-responses");
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
