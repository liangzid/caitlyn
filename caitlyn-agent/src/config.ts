/**
 * CAITLYN Agent — Configuration
 *
 * Reads from environment variables and defaults.
 * No longer depends on caitlynd daemon — scanning is self-contained.
 */
export interface CaitlynAgentConfig {
  provider: string;
  model: string;
}

export function loadConfig(): CaitlynAgentConfig {
  return {
    provider: process.env.CAITLYN_PROVIDER ?? "openrouter",
    model: process.env.CAITLYN_MODEL ?? "deepseek/deepseek-chat",
  };
}
