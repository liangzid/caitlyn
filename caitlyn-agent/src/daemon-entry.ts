/**
 * CAITLYN Daemon — Entry Point
 *
 * Started by `caitlyn daemon start`. Runs the HTTP server in the background.
 * Auto-configures the LLM provider from env vars (DEEPSEEK_API_KEY etc.)
 * or config.toml. Falls back to Tier 0 only when no API key is available.
 *
 * Usage: node dist/daemon-entry.js [--port 9070]
 */

import { DaemonServer } from "./daemon/server.js";
import { writePidFile, removePidFile } from "./daemon/lifecycle.js";
import { loadConfig } from "./config.js";
import { resolveModel } from "./llm.js";
import { complete } from "@earendil-works/pi-ai/compat";
import type { LlmCallFn } from "./scanner.js";
import { getCredentialEnv } from "./config/credentials.js";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? parseInt(args[portArg + 1], 10) || 9070 : 9070;

const server = new DaemonServer({ port });

// ── LLM Setup ────────────────────────────────────────────────────────

function hasAnyApiKey(): boolean {
  const candidates = [
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
  ];
  return candidates.some((k) => process.env[k]);
}

function makeDaemonLlmCall(): LlmCallFn | null {
  const config = loadConfig();
  const credentialEnv = getCredentialEnv(config.provider);
  if (!hasAnyApiKey() && !credentialEnv) {
    console.error("[daemon] No API key found (DEEPSEEK_API_KEY etc.). Tier 1 disabled — Tier 0 only.");
    return null;
  }
  try {
    const model = resolveModel(config);
    console.error(`[daemon] LLM provider: ${config.provider} / ${config.model}`);
    return async (systemPrompt: string, userPrompt: string) => {
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
      const response = await complete(model, ctx, credentialEnv ? { env: credentialEnv } : undefined);
      const textBlocks = response.content.filter(
        (c): c is { type: "text"; text: string } => c.type === "text",
      );
      return textBlocks.map((c) => c.text).join("");
    };
  } catch (err) {
    console.error(`[daemon] LLM setup failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const llmCall = makeDaemonLlmCall();
if (llmCall) server.setLlmCall(llmCall);

// ── Lifecycle ────────────────────────────────────────────────────────

process.on("SIGTERM", async () => {
  await server.stop();
  removePidFile();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await server.stop();
  removePidFile();
  process.exit(0);
});

try {
  await server.start();
  writePidFile();
  console.error(`[daemon] Listening on port ${port} (PID ${process.pid})`);
  // Keep process alive
  process.stdin.resume();
} catch (err) {
  console.error("Failed to start daemon:", err);
  process.exit(1);
}
