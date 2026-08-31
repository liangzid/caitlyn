/**
 * CAITLYN guided setup workflow.
 *
 * Business decisions are separated from terminal rendering so the complete
 * first-run flow can be exercised deterministically in tests.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  GUARD_RUNTIME_DEFAULTS,
  SCANNING_DEFAULTS,
  getUserConfigPath,
  loadConfig,
  loadConfigFile,
  loadGuardRuntimeConfig,
  loadScanningConfig,
  type CaitlynAgentConfig,
  type GuardRuntimeConfig,
  type ScanningConfig,
} from "../config.js";
import {
  checkProviderAuth,
  getProviderEnvVars,
  persistApiKey,
} from "../config/credentials.js";
import { getModels, getProviders, resolveModel } from "../llm.js";
import { verifyConfiguredLlm } from "../llm-runtime.js";
import {
  detectAgents,
  installAgent,
  isHookInstalled,
  type DetectResult,
  type InstallResult,
} from "../adapters/registry.js";
import {
  rollbackSetupConfig,
  writeSetupConfig,
  type SetupConfigDocument,
} from "./config-writer.js";
import type { SetupChoice, SetupPrompts } from "./types.js";

export type DetectionPreset = "local" | "balanced" | "strict" | "custom";

export interface SetupRunOptions {
  configPath?: string;
  skipConnectionTest?: boolean;
}

export interface SetupRunResult {
  configPath: string;
  backupPath: string | null;
  provider: string;
  model: string;
  detectionPreset: DetectionPreset;
  installedAgents: string[];
  failedAgents: string[];
  connectionVerified: boolean;
}

interface SetupServices {
  providers(): string[];
  models(provider: string): Array<Pick<Model<any>, "id" | "name" | "cost">>;
  authStatus(provider: string): ReturnType<typeof checkProviderAuth>;
  providerEnvVars(provider: string): readonly string[];
  saveApiKey(provider: string, apiKey: string): void;
  verify(config: CaitlynAgentConfig, apiKey?: string): Promise<string>;
  detectAgents(): DetectResult[];
  hookInstalled(agentId: string): boolean;
  installAgent(agentId: string, dryRun: boolean): InstallResult;
  writeConfig(configPath: string, document: SetupConfigDocument): ReturnType<typeof writeSetupConfig>;
  validateConfig(configPath: string, document: SetupConfigDocument): void;
}

const COMMON_PROVIDERS = [
  "openrouter",
  "deepseek",
  "openai",
  "anthropic",
  "google",
  "groq",
  "mistral",
  "moonshotai",
] as const;

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  openrouter: "One key for a broad multi-provider model catalog",
  deepseek: "Direct DeepSeek API",
  openai: "OpenAI API",
  anthropic: "Anthropic API or OAuth token",
  google: "Google Gemini API",
  groq: "Low-latency hosted inference",
  mistral: "Mistral API",
  moonshotai: "Moonshot AI and Kimi models",
};

const RECOMMENDED_MODELS: Record<string, string[]> = {
  openrouter: [
    "deepseek/deepseek-v4-flash",
    "openai/gpt-5.4-mini",
    "google/gemini-3-flash-preview",
    "anthropic/claude-sonnet-4.6",
  ],
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  openai: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.3-chat-latest"],
  anthropic: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"],
  google: ["gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-2.5-flash"],
  groq: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"],
  mistral: ["mistral-small-latest", "mistral-medium-latest", "codestral-latest"],
  moonshotai: ["kimi-k2-thinking", "kimi-k2.5", "kimi-k2-turbo-preview"],
};

const AGENT_COVERAGE: Record<string, string> = {
  "claude-code": "PreToolUse and PostToolUse hooks cover tool input and output",
  codex: "Bash hooks; filesystem watcher is recommended for Read, Write, and Edit coverage",
  opencode: "Plugin scans every tool call before and after execution",
  hermes: "Python plugin scans tool calls before execution",
  openclaw: "Plugin scans tool calls before and after execution",
  pi: "Middleware source and manual integration instructions",
};

/** Real service boundary used by the command-line and TUI entry points. */
const DEFAULT_SERVICES: SetupServices = {
  providers: () => [...getProviders()],
  models: (provider) => {
    const known = getProviders().find((candidate) => candidate === provider);
    return known ? getModels(known) : [];
  },
  authStatus: checkProviderAuth,
  providerEnvVars: getProviderEnvVars,
  saveApiKey: persistApiKey,
  verify: verifyConfiguredLlm,
  detectAgents,
  hookInstalled: isHookInstalled,
  installAgent,
  writeConfig: writeSetupConfig,
  validateConfig: validateWrittenConfig,
};

/** Run the complete first-use setup and apply changes only after confirmation. */
export async function runSetupWizard(
  prompts: SetupPrompts,
  options: SetupRunOptions = {},
  serviceOverrides: Partial<SetupServices> = {},
): Promise<SetupRunResult> {
  const services = { ...DEFAULT_SERVICES, ...serviceOverrides };
  prompts.heading("CAITLYN guided setup");
  prompts.info("Nothing is changed until the final confirmation. Enter q at a menu to cancel.");

  const configPath = options.configPath
    ? path.resolve(options.configPath)
    : await chooseConfigPath(prompts);
  const existing = loadConfig(configPath);

  prompts.heading("1. Language model provider");
  const provider = await chooseProvider(prompts, services, existing.provider);
  const model = await chooseModel(prompts, services, provider, existing);
  const llmConfig: CaitlynAgentConfig = { provider, model, smallModel: model };
  const credential = await configureCredential(prompts, services, llmConfig, options);

  prompts.heading("2. Agent integrations");
  const agents = services.detectAgents();
  showDetectedAgents(prompts, agents, services);
  const selectedAgentIds = await chooseAgents(prompts, agents, services);
  previewAgentChanges(prompts, selectedAgentIds, services);

  prompts.heading("3. Detection depth and response policy");
  const detectionPreset = await prompts.select<DetectionPreset>(
    "Choose a detection profile",
    detectionPresetChoices(),
    credential.available ? "balanced" : "local",
  );
  let document = presetDocument(detectionPreset, llmConfig);
  const reviewAdvanced = detectionPreset === "custom"
    || await prompts.confirm("Review and customize every detection setting?", false);
  if (reviewAdvanced) document = await customizeDetection(prompts, document);
  await confirmDetectionAvailability(prompts, document.scanning, credential.available);

  showFinalSummary(prompts, configPath, document, selectedAgentIds, credential);
  if (!await prompts.confirm("Apply this configuration now?", true)) {
    throw new Error("Setup was not applied");
  }

  const writeResult = services.writeConfig(configPath, document);
  try {
    services.validateConfig(configPath, document);
    if (credential.pendingKey) services.saveApiKey(provider, credential.pendingKey);
  } catch (error) {
    rollbackSetupConfig(writeResult);
    throw error;
  }

  const installedAgents: string[] = [];
  const failedAgents: string[] = [];
  for (const agentId of selectedAgentIds) {
    if (services.hookInstalled(agentId)) continue;
    const result = services.installAgent(agentId, false);
    if (result.success) installedAgents.push(agentId);
    else failedAgents.push(agentId);
  }

  prompts.heading("Setup complete");
  prompts.success(`Configuration: ${writeResult.configPath}`);
  if (writeResult.backupPath) prompts.info(`Previous configuration backup: ${writeResult.backupPath}`);
  prompts.info(`Provider: ${provider}/${model}`);
  prompts.info(`Detection profile: ${detectionPreset}`);
  prompts.info(`Agent integrations installed: ${installedAgents.join(", ") || "none"}`);
  if (failedAgents.length > 0) prompts.warn(`Agent installation failed: ${failedAgents.join(", ")}`);
  prompts.info("Run `caitlyn scan \"test content\"` or `caitlyn tui` to begin.");

  return {
    configPath: writeResult.configPath,
    backupPath: writeResult.backupPath,
    provider,
    model,
    detectionPreset,
    installedAgents,
    failedAgents,
    connectionVerified: credential.verified,
  };
}

/** Let the operator choose user, project, or explicit configuration scope. */
async function chooseConfigPath(prompts: SetupPrompts): Promise<string> {
  const userPath = getUserConfigPath();
  const projectPath = path.resolve("config.toml");
  const projectExists = fs.existsSync(projectPath);
  const scope = await prompts.select(
    "Where should these defaults apply?",
    [
      {
        value: "user",
        label: `All projects (${userPath})`,
        description: "Recommended for a globally installed caitlyn command",
      },
      {
        value: "project",
        label: `Current project (${projectPath})`,
        description: projectExists ? "Existing project configuration will be merged" : "Only this project inherits the settings",
      },
      { value: "custom", label: "Custom config path" },
    ],
    projectExists ? "project" : "user",
  );
  if (scope === "user") return userPath;
  if (scope === "project") return projectPath;
  return path.resolve(await requireText(prompts, "Configuration path"));
}

/** Choose a common provider first while retaining access to the full catalog. */
async function chooseProvider(
  prompts: SetupPrompts,
  services: SetupServices,
  existingProvider: string,
): Promise<string> {
  const providers = services.providers();
  if (providers.length === 0) throw new Error("No LLM providers are available in this installation");
  const common = COMMON_PROVIDERS.filter((provider) => providers.includes(provider));
  const initialChoices: SetupChoice<string>[] = common.map((provider) => ({
    value: provider,
    label: provider,
    description: providerDescription(provider, services),
  }));
  initialChoices.push({ value: "__all__", label: `Show all ${providers.length} providers` });
  const defaultProvider = common.includes(existingProvider as typeof COMMON_PROVIDERS[number])
    ? existingProvider
    : common[0];
  const selected = await prompts.select("Provider", initialChoices, defaultProvider);
  if (selected !== "__all__") return selected;

  return prompts.select(
    "Provider",
    providers.map((provider) => ({
      value: provider,
      label: provider,
      description: providerDescription(provider, services),
    })),
    providers.includes(existingProvider) ? existingProvider : providers[0],
  );
}

/** Describe provider purpose and whether credentials already exist. */
function providerDescription(provider: string, services: SetupServices): string {
  const auth = services.authStatus(provider);
  const status = auth.persisted ? "saved key found" : auth.env ? "environment credential found" : "not configured";
  const description = PROVIDER_DESCRIPTIONS[provider] ?? "Supported by the bundled model catalog";
  return `${description}; ${status}`;
}

/** Choose a recommended model or search the complete provider catalog. */
async function chooseModel(
  prompts: SetupPrompts,
  services: SetupServices,
  provider: string,
  existing: CaitlynAgentConfig,
): Promise<string> {
  const models = services.models(provider);
  if (models.length === 0) throw new Error(`Provider ${provider} has no models in the installed catalog`);
  const byId = new Map(models.map((model) => [model.id, model]));
  const recommendedIds = [
    ...(existing.provider === provider ? [existing.model] : []),
    ...(RECOMMENDED_MODELS[provider] ?? []),
    ...models.slice(0, 6).map((model) => model.id),
  ].filter((id, index, all) => byId.has(id) && all.indexOf(id) === index);
  const choices = recommendedIds.map((id) => modelChoice(byId.get(id)!));
  choices.push({ value: "__search__", label: `Search all ${models.length} models` });
  if (provider === "openrouter") {
    choices.push({ value: "__custom__", label: "Enter a custom OpenRouter model ID" });
  }

  const selected = await prompts.select(
    "Model",
    choices,
    recommendedIds.includes(existing.model) ? existing.model : recommendedIds[0],
  );
  if (selected === "__custom__") return requireText(prompts, "OpenRouter model ID");
  if (selected !== "__search__") return selected;
  return searchModelCatalog(prompts, models);
}

/** Search the provider model catalog without dumping hundreds of entries. */
async function searchModelCatalog(
  prompts: SetupPrompts,
  models: Array<Pick<Model<any>, "id" | "name" | "cost">>,
): Promise<string> {
  while (true) {
    const query = (await requireText(prompts, "Model search text")).toLowerCase();
    const matches = models.filter((model) =>
      model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query)
    );
    if (matches.length === 0) {
      prompts.warn("No matching models. Try another search term.");
      continue;
    }
    const visible = matches.slice(0, 25);
    if (matches.length > visible.length) {
      prompts.info(`Showing the first ${visible.length} of ${matches.length} matches. Refine the search to narrow it.`);
    }
    return prompts.select("Model", visible.map(modelChoice), visible[0].id);
  }
}

/** Format a model with pricing metadata when the catalog provides it. */
function modelChoice(model: Pick<Model<any>, "id" | "name" | "cost">): SetupChoice<string> {
  const price = model.cost
    ? `$${model.cost.input}/M input, $${model.cost.output}/M output`
    : "pricing unavailable";
  return { value: model.id, label: model.id, description: `${model.name}; ${price}` };
}

interface CredentialSelection {
  available: boolean;
  pendingKey?: string;
  source: "environment" | "saved" | "new" | "external" | "none";
  verified: boolean;
}

/** Reuse an existing credential or securely collect and validate a new key. */
async function configureCredential(
  prompts: SetupPrompts,
  services: SetupServices,
  config: CaitlynAgentConfig,
  options: SetupRunOptions,
): Promise<CredentialSelection> {
  const auth = services.authStatus(config.provider);
  const existingSource = auth.env ? "environment" : auth.persisted ? "saved" : null;
  let pendingKey: string | undefined;
  let source: CredentialSelection["source"] = existingSource ?? "none";

  if (existingSource) {
    const useExisting = await prompts.confirm(
      `Use the existing ${existingSource} credential for ${config.provider}?`,
      true,
    );
    if (!useExisting) pendingKey = await requireSecret(prompts, config.provider);
  } else if (services.providerEnvVars(config.provider).length > 0) {
    pendingKey = await requireSecret(prompts, config.provider);
  } else {
    source = "external";
    prompts.warn(
      `${config.provider} uses external or multi-field authentication. Configure it with the provider tooling before Tier 1 scans.`,
    );
  }
  if (pendingKey) source = "new";
  const available = Boolean(existingSource || pendingKey);

  if (!available || options.skipConnectionTest) {
    return { available, pendingKey, source, verified: false };
  }
  if (!await prompts.confirm("Test this provider and model with a real API request?", true)) {
    return { available, pendingKey, source, verified: false };
  }

  while (true) {
    try {
      const response = await services.verify(config, pendingKey);
      prompts.success(`Provider connection verified (${response.trim().slice(0, 60) || "response received"}).`);
      return { available, pendingKey, source, verified: true };
    } catch (error) {
      prompts.warn(`Connection test failed: ${redactError(error, pendingKey)}`);
      const action = await prompts.select(
        "How should setup continue?",
        [
          { value: "retry", label: "Enter the API key again" },
          { value: "continue", label: "Keep configuration without verification" },
          { value: "cancel", label: "Cancel setup" },
        ],
        "retry",
      );
      if (action === "continue") return { available, pendingKey, source, verified: false };
      if (action === "cancel") throw new Error("Setup cancelled after provider verification failed");
      pendingKey = await requireSecret(prompts, config.provider);
      source = "new";
    }
  }
}

/** Read a non-empty secret without ever including it in diagnostics. */
async function requireSecret(prompts: SetupPrompts, provider: string): Promise<string> {
  while (true) {
    const value = await prompts.secret(`${provider} API key (input hidden)`);
    if (value.length > 0) return value;
    prompts.warn("The API key cannot be empty.");
  }
}

/** Redact the exact pending secret if an SDK happens to echo it in an error. */
function redactError(error: unknown, pendingKey?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return pendingKey ? message.split(pendingKey).join("[REDACTED]") : message;
}

/** Display every supported adapter and its detected/integrated state. */
function showDetectedAgents(
  prompts: SetupPrompts,
  agents: DetectResult[],
  services: SetupServices,
): void {
  for (const result of agents) {
    const state = !result.installed
      ? "not detected"
      : services.hookInstalled(result.agent.id)
        ? "detected; CAITLYN already installed"
        : "detected; not protected yet";
    prompts.info(`${result.agent.name}: ${state}`);
    prompts.info(`  ${AGENT_COVERAGE[result.agent.id] ?? result.agent.description}`);
    if (result.foundPaths.length > 0) prompts.info(`  Found: ${result.foundPaths.join(", ")}`);
  }
}

/** Select zero or more detected, not-yet-protected Agent adapters. */
async function chooseAgents(
  prompts: SetupPrompts,
  agents: DetectResult[],
  services: SetupServices,
): Promise<string[]> {
  const candidates = agents.filter((result) => result.installed && !services.hookInstalled(result.agent.id));
  if (candidates.length === 0) {
    prompts.info("No unprotected supported Agents were detected. You can run `caitlyn detect` later.");
    return [];
  }
  return prompts.multiSelect(
    "Install CAITLYN integration for",
    candidates.map((result) => ({
      value: result.agent.id,
      label: result.agent.name,
      description: AGENT_COVERAGE[result.agent.id] ?? result.agent.description,
    })),
    candidates.map((result) => result.agent.id),
  );
}

/** Dry-run every selected adapter and display its exact file operations. */
function previewAgentChanges(
  prompts: SetupPrompts,
  agentIds: string[],
  services: SetupServices,
): void {
  for (const agentId of agentIds) {
    const preview = services.installAgent(agentId, true);
    prompts.info(`${agentId} preview: ${preview.message}`);
    for (const file of preview.filesCreated) prompts.info(`  create ${file}`);
    for (const file of preview.filesModified) prompts.info(`  modify ${file}`);
  }
}

/** Explain the detection presets in terms of latency, cost, and coverage. */
function detectionPresetChoices(): SetupChoice<DetectionPreset>[] {
  return [
    {
      value: "balanced",
      label: "Balanced (recommended)",
      description: "Tier 0 first, then adaptive Tier 1; good coverage with bounded API cost",
    },
    {
      value: "local",
      label: "Local only",
      description: "Tier 0 scripts and signatures only; no API calls and lowest latency",
    },
    {
      value: "strict",
      label: "Strict",
      description: "Tier 0 plus two merged Tier 1 judgments on every clean input; higher cost and latency",
    },
    {
      value: "custom",
      label: "Custom",
      description: "Configure each detector, escalation, timeout, and enforcement option",
    },
  ];
}

/** Build safe, explicit defaults for one detection profile. */
export function presetDocument(
  preset: DetectionPreset,
  llm: CaitlynAgentConfig,
): SetupConfigDocument {
  const scanning: ScanningConfig = {
    ...SCANNING_DEFAULTS,
    fastDetectorIds: [...SCANNING_DEFAULTS.fastDetectorIds],
  };
  const guard: GuardRuntimeConfig = { ...GUARD_RUNTIME_DEFAULTS };
  if (preset === "local") {
    scanning.skipTier1 = true;
    guard.hookTimeoutMs = 3_000;
  } else if (preset === "strict") {
    scanning.tier1Mode = "merged-pair";
    scanning.policy = "off";
    scanning.sourceTrust = "low";
    scanning.highRisk = true;
    scanning.tier1TimeoutMs = 25_000;
    guard.hookTimeoutMs = 55_000;
    guard.suspiciousAction = "block";
  } else {
    guard.hookTimeoutMs = 20_000;
  }
  return { llm, scanning, guard };
}

/** Prompt for every supported detection and hook enforcement setting. */
export async function customizeDetection(
  prompts: SetupPrompts,
  document: SetupConfigDocument,
): Promise<SetupConfigDocument> {
  const scanning = { ...document.scanning, fastDetectorIds: [...document.scanning.fastDetectorIds] };
  const guard = { ...document.guard };

  scanning.skipTier0 = !await prompts.confirm("Enable Tier 0 local scripts and signatures?", !scanning.skipTier0);
  if (!scanning.skipTier0) {
    scanning.tier0TimeoutMs = await askInteger(
      prompts,
      "Tier 0 timeout per detector in milliseconds",
      scanning.tier0TimeoutMs,
      50,
      60_000,
    );
  }
  scanning.skipTier1 = !await prompts.confirm("Enable Tier 1 LLM detection?", !scanning.skipTier1);
  if (!scanning.skipTier1) {
    scanning.tier1Mode = await prompts.select(
      "Tier 1 execution mode",
      [
        { value: "ensemble", label: "Ensemble", description: "Independent detector calls with optional adaptive escalation" },
        { value: "merged", label: "Merged", description: "One combined judgment; lower API call count" },
        { value: "merged-pair", label: "Merged pair", description: "Two combined judgments with OR voting; stronger and slower" },
      ],
      scanning.tier1Mode,
    );
    if (scanning.tier1Mode === "merged") {
      scanning.mergedScope = await prompts.select(
        "Knowledge included in the merged prompt",
        [
          { value: "knowledge", label: "All Tier 1 knowledge" },
          { value: "detectors", label: "Detector skills only" },
        ],
        scanning.mergedScope,
      );
    }
    if (scanning.tier1Mode === "ensemble") {
      scanning.policy = await prompts.select(
        "Escalation policy",
        [
          { value: "safe", label: "Safe adaptive", description: "Fast subset first, expand on weak signals" },
          { value: "aggressive", label: "Cost-saving adaptive", description: "Trusted clean inputs may skip Tier 1" },
          { value: "off", label: "Always full ensemble", description: "No escalation gate; highest call count" },
        ],
        scanning.policy,
      );
      scanning.fastDetectorIds = await askStringList(
        prompts,
        "Fast detector IDs (comma-separated)",
        scanning.fastDetectorIds,
      );
    }
    scanning.sourceTrust = await prompts.select(
      "Default source trust",
      [
        { value: "low", label: "Low", description: "External or adversarial content" },
        { value: "medium", label: "Medium", description: "Mixed local and external content" },
        { value: "high", label: "High", description: "Controlled internal content" },
      ],
      scanning.sourceTrust,
    );
    scanning.highRisk = await prompts.confirm("Treat scans as high risk by default?", scanning.highRisk);
    scanning.weakSignalThreshold = await askNumber(
      prompts,
      "Tier 0 weak-signal threshold (0 to 1)",
      scanning.weakSignalThreshold,
      0,
      1,
    );
    scanning.tier1TimeoutMs = await askInteger(
      prompts,
      "Tier 1 timeout per LLM call in milliseconds",
      scanning.tier1TimeoutMs,
      1_000,
      120_000,
    );
    scanning.maxParallelTier1 = await askInteger(
      prompts,
      "Maximum parallel Tier 1 calls",
      scanning.maxParallelTier1,
      1,
      64,
    );
  }

  if (scanning.skipTier0 && scanning.skipTier1) {
    const accepted = await prompts.confirm(
      "Both detection tiers are disabled. Keep this no-detection configuration?",
      false,
    );
    if (!accepted) scanning.skipTier0 = false;
  }

  guard.enabled = await prompts.confirm("Enable Agent hook enforcement?", guard.enabled);
  if (guard.enabled) {
    guard.beforeEnabled = await prompts.confirm("Scan tool input before execution?", guard.beforeEnabled);
    guard.afterEnabled = await prompts.confirm("Scan tool output after execution?", guard.afterEnabled);
    guard.maxScanBytes = await askInteger(
      prompts,
      "Maximum bytes scanned per hook",
      guard.maxScanBytes,
      1_024,
      10 * 1024 * 1024,
    );
    guard.hookTimeoutMs = await askInteger(
      prompts,
      "Whole-hook timeout in milliseconds",
      guard.hookTimeoutMs,
      500,
      300_000,
    );
    guard.onError = await prompts.select(
      "If scanning errors or times out",
      [
        { value: "allow", label: "Fail open", description: "Preserve Agent availability" },
        { value: "block", label: "Fail closed", description: "Prefer containment over availability" },
      ],
      guard.onError,
    );
    guard.suspiciousAction = await prompts.select(
      "Action for suspicious input",
      verdictActionChoices(),
      guard.suspiciousAction,
    );
    guard.maliciousAction = await prompts.select(
      "Action for malicious input",
      verdictActionChoices(),
      guard.maliciousAction,
    );
    prompts.info("Post-execution hooks always flag instead of block because the tool has already run.");
  }

  return { ...document, scanning, guard };
}

/** Choices shared by suspicious and malicious hook verdicts. */
function verdictActionChoices(): SetupChoice<"allow" | "flag" | "block">[] {
  return [
    { value: "allow", label: "Allow" },
    { value: "flag", label: "Allow and flag" },
    { value: "block", label: "Block" },
  ];
}

/** Require explicit acknowledgement when Tier 1 lacks credentials. */
async function confirmDetectionAvailability(
  prompts: SetupPrompts,
  scanning: ScanningConfig,
  credentialAvailable: boolean,
): Promise<void> {
  if (scanning.skipTier1 || credentialAvailable) return;
  prompts.warn("Tier 1 is enabled but no API credential was detected. Tier 1 calls will fail until authentication is configured.");
  if (!await prompts.confirm("Keep Tier 1 enabled anyway?", false)) scanning.skipTier1 = true;
}

/** Present a secret-free summary before any filesystem mutation. */
function showFinalSummary(
  prompts: SetupPrompts,
  configPath: string,
  document: SetupConfigDocument,
  agentIds: string[],
  credential: CredentialSelection,
): void {
  const { scanning, guard, llm } = document;
  prompts.heading("4. Review");
  prompts.info(`Config: ${configPath}`);
  prompts.info(`Provider/model: ${llm.provider}/${llm.model}`);
  prompts.info(`Credential: ${credential.source}${credential.verified ? "; verified" : "; not verified"}`);
  prompts.info(`Tier 0: ${scanning.skipTier0 ? "disabled" : `enabled (${scanning.tier0TimeoutMs}ms per detector)`}`);
  prompts.info(`Tier 1: ${scanning.skipTier1 ? "disabled" : `${scanning.tier1Mode}, ${scanning.tier1TimeoutMs}ms, parallel=${scanning.maxParallelTier1}`}`);
  prompts.info(`Escalation/trust: ${scanning.policy}, ${scanning.sourceTrust}, high-risk=${scanning.highRisk}`);
  prompts.info(`Hooks: ${guard.enabled ? `before=${guard.beforeEnabled}, after=${guard.afterEnabled}, on-error=${guard.onError}` : "disabled"}`);
  prompts.info(`Verdict actions: suspicious=${guard.suspiciousAction}, malicious=${guard.maliciousAction}`);
  prompts.info(`Agent integrations: ${agentIds.join(", ") || "none"}`);
}

/** Validate every setup-owned field through the actual runtime readers. */
function validateWrittenConfig(configPath: string, expected: SetupConfigDocument): void {
  const llm = loadConfigFile(configPath);
  const scanning = loadScanningConfig(configPath);
  const guard = loadGuardRuntimeConfig(configPath);
  resolveModel(llm);
  if (JSON.stringify(llm) !== JSON.stringify(expected.llm)) {
    throw new Error("Written [llm] configuration did not round-trip");
  }
  if (JSON.stringify(scanning) !== JSON.stringify(expected.scanning)) {
    throw new Error("Written [scanning] configuration did not round-trip");
  }
  if (JSON.stringify(guard) !== JSON.stringify(expected.guard)) {
    throw new Error("Written [guard] configuration did not round-trip");
  }
}

/** Prompt until a non-empty text value is provided. */
async function requireText(prompts: SetupPrompts, message: string): Promise<string> {
  while (true) {
    const value = (await prompts.input(message)).trim();
    if (value) return value;
    prompts.warn("A value is required.");
  }
}

/** Prompt for a finite number constrained to an inclusive range. */
async function askNumber(
  prompts: SetupPrompts,
  message: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): Promise<number> {
  while (true) {
    const raw = await prompts.input(message, String(defaultValue));
    const value = Number(raw);
    if (Number.isFinite(value) && value >= minimum && value <= maximum) return value;
    prompts.warn(`Enter a number from ${minimum} to ${maximum}.`);
  }
}

/** Prompt for an integer constrained to an inclusive range. */
async function askInteger(
  prompts: SetupPrompts,
  message: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): Promise<number> {
  while (true) {
    const value = await askNumber(prompts, message, defaultValue, minimum, maximum);
    if (Number.isInteger(value)) return value;
    prompts.warn("Enter a whole number.");
  }
}

/** Prompt for a non-empty comma-separated identifier list. */
async function askStringList(
  prompts: SetupPrompts,
  message: string,
  defaultValue: string[],
): Promise<string[]> {
  while (true) {
    const raw = await prompts.input(message, defaultValue.join(","));
    const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
    if (values.length > 0) return [...new Set(values)];
    prompts.warn("Enter at least one detector ID.");
  }
}
