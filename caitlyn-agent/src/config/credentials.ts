/**
 * CAITLYN Credentials
 *
 * 4-tier API key resolution:
 *   1. Runtime override (--api-key provider:KEY)
 *   2. ~/.caitlyn/auth.json persisted credentials
 *   3. ~/.caitlyn/config.toml api_key field ($VAR, ${VAR}, !command)
 *   4. Environment variables (OPENAI_API_KEY, etc.)
 *
 * Leverages pi-ai's built-in auth system which handles tiers 3-4.
 * Tier 2 (persisted file) is CAITLYN-specific.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getProviders } from "../llm.js";

// ── Config ────────────────────────────────────────────────────────

/** Provider id → environment variable names used for API keys. */
const PROVIDER_ENV_VARS: Record<string, string[]> = {
  "ant-ling": ["ANT_LING_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  groq: ["GROQ_API_KEY"],
  google: ["GEMINI_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  huggingface: ["HF_TOKEN"],
  together: ["TOGETHER_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  xai: ["XAI_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
};

/** Resolve the private CAITLYN credential store at call time. */
export function getAuthFilePath(): string {
  const configuredHome = process.env.CAITLYN_HOME?.trim();
  const caitlynDir = configuredHome
    ? path.resolve(configuredHome)
    : path.join(os.homedir(), ".caitlyn");
  return path.join(caitlynDir, "auth.json");
}

/** Return the recognized API-key environment variables for a provider. */
export function getProviderEnvVars(provider: string): readonly string[] {
  return PROVIDER_ENV_VARS[provider] ?? [];
}

/** Build an isolated environment override for a newly entered API key. */
export function buildCredentialEnv(
  provider: string,
  apiKey: string,
): Record<string, string> | undefined {
  const envVar = getProviderEnvVars(provider)[0];
  return envVar ? { [envVar]: apiKey } : undefined;
}

// ── Auth Store ────────────────────────────────────────────────────

interface AuthEntry {
  provider: string;
  apiKey?: string;
  updatedAt: number;
}

interface AuthStore {
  providers: Record<string, AuthEntry>;
}

function readAuthStore(): AuthStore {
  const authFile = getAuthFilePath();
  try {
    if (!fs.existsSync(authFile)) return { providers: {} };
    const raw = fs.readFileSync(authFile, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { providers: {} };
  }
}

function writeAuthStore(store: AuthStore): void {
  const authFile = getAuthFilePath();
  const authDir = path.dirname(authFile);
  const temporary = `${authFile}.tmp-${process.pid}`;
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(authDir, 0o700);
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.renameSync(temporary, authFile);
  fs.chmodSync(authFile, 0o600);
}

/** Get a persisted API key for a provider. */
export function getPersistedApiKey(provider: string): string | undefined {
  const store = readAuthStore();
  return store.providers[provider]?.apiKey;
}

/** Persist an API key for a provider. */
export function persistApiKey(provider: string, apiKey: string): void {
  const store = readAuthStore();
  store.providers[provider] = { provider, apiKey, updatedAt: Date.now() };
  writeAuthStore(store);
}

/** Remove a persisted API key. */
export function removeApiKey(provider: string): void {
  const store = readAuthStore();
  delete store.providers[provider];
  writeAuthStore(store);
}

// ── Runtime Overrides ────────────────────────────────────────────

const runtimeOverrides = new Map<string, string>();

/** Set a runtime-only API key (--api-key flag, never persisted). */
export function setRuntimeApiKey(provider: string, key: string): void {
  runtimeOverrides.set(provider, key);
}

export function getRuntimeApiKey(provider: string): string | undefined {
  return runtimeOverrides.get(provider);
}

// ── Full Resolution ──────────────────────────────────────────────

/** Check which providers have any form of authentication configured. */
export function checkProviderAuth(provider: string): {
  runtime: boolean;
  persisted: boolean;
  env: boolean;
} {
  return {
    runtime: runtimeOverrides.has(provider),
    persisted: !!getPersistedApiKey(provider),
    env: hasEnvApiKey(provider),
  };
}

/** Heuristic check for environment API key. */
function hasEnvApiKey(provider: string): boolean {
  const vars = getProviderEnvVars(provider);
  return vars.some((v) => process.env[v]);
}

/**
 * Build an env override for a provider from persisted credentials.
 * Returns undefined when the provider has no persisted key or when any
 * matching environment variable is already set (env wins).
 */
export function getCredentialEnv(
  provider: string,
): Record<string, string> | undefined {
  const vars = getProviderEnvVars(provider);
  if (vars.length === 0) return undefined;
  if (vars.some((v) => process.env[v])) return undefined;
  const key = getPersistedApiKey(provider);
  if (!key) return undefined;
  return { [vars[0]]: key };
}

/** List all providers with any form of auth configured. */
export function listConfiguredProviders(): string[] {
  return getProviders().filter((p) => {
    const auth = checkProviderAuth(p);
    return auth.runtime || auth.persisted || auth.env;
  });
}
