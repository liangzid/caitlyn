/**
 * CAITLYN Agent — Configuration
 *
 * Resolution order: env vars > config.toml > defaults.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface CaitlynAgentConfig {
  provider: string;
  model: string;
}

/** Minimal TOML section reader — reads [section] key=value pairs. */
function readTomlSection(filePath: string, section: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    let inSection = false;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const secMatch = trimmed.match(/^\[(\w+)\]$/);
      if (secMatch) {
        inSection = secMatch[1] === section;
        continue;
      }
      if (inSection) {
        const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
        if (kvMatch) {
          result[kvMatch[1]] = kvMatch[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
        }
      }
    }
  } catch {
    // Config file missing or unreadable — use defaults
  }
  return result;
}

export function loadConfig(): CaitlynAgentConfig {
  // 1. Check environment variables first
  const provider = process.env.CAITLYN_PROVIDER;
  const model = process.env.CAITLYN_MODEL;

  // 2. Fall back to config.toml [llm] section — search cwd and ancestors
  if (!provider || !model) {
    const configPath = findConfigUpward();
    const llm = readTomlSection(configPath, "llm");
    return {
      provider: provider ?? llm["provider"] ?? "openrouter",
      model: model ?? llm["model"] ?? "deepseek/deepseek-chat",
    };
  }

  return { provider, model };
}

/**
 * Find config.toml by searching cwd and its ancestors (like git).
 * Returns the path if found, or the default cwd path otherwise.
 */
function findConfigUpward(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "config.toml");
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* not readable */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), "config.toml");
}
