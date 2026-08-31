/**
 * CAITLYN Slash Commands & Autocomplete
 *
 * CombinedAutocompleteProvider for the Editor component.
 * Defines all slash commands with argument hints and completions.
 */

import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import type { SlashCommand, AutocompleteItem } from "@earendil-works/pi-tui";
import { loadAntibodies, loadAntigens } from "../library.js";
import { getProviders, getModels } from "../llm.js";

export interface CaitlynCommand {
  name: string;
  description: string;
  argumentHint?: string;
  getArgumentCompletions?: (
    prefix: string,
  ) =>
    | AutocompleteItem[]
    | Promise<AutocompleteItem[]>
    | null
    | Promise<null>;
}

/** All CAITLYN slash commands. */
export const CAITLYN_COMMANDS: CaitlynCommand[] = [
  // ── Scanning & Defense ──────────────────────────────────────────
  {
    name: "scan",
    description: "Scan content for attacks",
    argumentHint: "<content>",
  },
  {
    name: "status",
    description: "Show antibody/antigen library",
  },
  {
    name: "dashboard",
    description: "Defense dashboard",
  },
  {
    name: "history",
    description: "Recent scan history",
    argumentHint: "[N]",
  },
  {
    name: "guard",
    description: "Agent protection & watch status",
  },

  // ── Antibody Management ─────────────────────────────────────────
  {
    name: "antibody",
    description: "Manage antibodies",
    argumentHint: "list|add|remove <id>",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const antibodies = loadAntibodies();
      if (prefix.startsWith("add ")) return null;
      if (prefix.startsWith("remove ")) {
        return antibodies.map((a) => ({
          value: a.config.id,
          label: a.config.name ?? a.config.id,
        }));
      }
      return [
        { value: "list", label: "list" },
        { value: "add", label: "add <id>" },
        { value: "remove", label: "remove <id>" },
      ];
    },
  },
  {
    name: "antigen",
    description: "Show antigen details",
    argumentHint: "<id>",
    getArgumentCompletions(): AutocompleteItem[] | null {
      const antigens = loadAntigens();
      return antigens.map((a) => ({
        value: a.config.id,
        label: a.config.name ?? a.config.id,
      }));
    },
  },
  {
    name: "vaccinate",
    description: "Evolve antibody",
    argumentHint: "<pattern>",
  },

  // ── Session Commands ────────────────────────────────────────────
  {
    name: "new",
    description: "Start a new session",
  },
  {
    name: "resume",
    description: "Resume a different session",
  },
  {
    name: "session",
    description: "Show session info",
  },
  {
    name: "name",
    description: "Set session name",
    argumentHint: "<title>",
  },
  {
    name: "export",
    description: "Export session",
    argumentHint: "[path]",
  },
  {
    name: "compact",
    description: "Compact session context",
  },
  {
    name: "tree",
    description: "Navigate session tree",
  },
  {
    name: "fork",
    description: "Branch from previous message",
    argumentHint: "[message-id]",
  },
  {
    name: "clone",
    description: "Duplicate session",
  },
  {
    name: "delete",
    description: "Delete this session",
  },

  // ── Config Commands ─────────────────────────────────────────────
  {
    name: "model",
    description: "Select LLM model",
    argumentHint: "<provider/model>",
    getArgumentCompletions(_prefix: string): AutocompleteItem[] | null {
      const items: AutocompleteItem[] = [];
      for (const provider of getProviders()) {
        for (const model of getModels(provider)) {
          items.push({
            value: `${provider}/${model.id}`,
            label: `${model.id} (${provider})`,
          });
        }
      }
      return items;
    },
  },
  {
    name: "thinking",
    description: "Set thinking level",
    argumentHint: "off|low|medium|high",
    getArgumentCompletions(): AutocompleteItem[] | null {
      return [
        { value: "off", label: "off" },
        { value: "low", label: "low" },
        { value: "medium", label: "medium" },
        { value: "high", label: "high" },
      ];
    },
  },
  {
    name: "login",
    description: "Configure auth",
    argumentHint: "<provider> [api-key]",
    getArgumentCompletions(): AutocompleteItem[] | null {
      return getProviders().map((p) => ({
        value: p,
        label: p,
      }));
    },
  },
  {
    name: "settings",
    description: "Open settings",
  },
  {
    name: "setup",
    description: "Run guided provider, Agent, and detection setup",
  },

  // ── Meta ────────────────────────────────────────────────────────
  {
    name: "help",
    description: "Show commands",
  },
  {
    name: "quit",
    description: "Exit CAITLYN",
  },
  {
    name: "clear",
    description: "Clear screen",
  },
];

/** Build slash command definitions for CombinedAutocompleteProvider. */
export function buildSlashCommands(): SlashCommand[] {
  return CAITLYN_COMMANDS.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    argumentHint: cmd.argumentHint,
    getArgumentCompletions: cmd.getArgumentCompletions
      ? async (prefix: string) => cmd.getArgumentCompletions!(prefix)
      : undefined,
  }));
}

/** Create the complete autocomplete provider for the CAITLYN TUI. */
export function createAutocompleteProvider(): CombinedAutocompleteProvider {
  return new CombinedAutocompleteProvider(buildSlashCommands(), process.cwd());
}
