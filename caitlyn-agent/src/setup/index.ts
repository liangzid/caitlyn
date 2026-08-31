/**
 * CAITLYN guided setup public entry point.
 */

export { runSetupWizard, presetDocument, customizeDetection } from "./workflow.js";
export type { DetectionPreset, SetupRunOptions, SetupRunResult } from "./workflow.js";
export { TerminalSetupPrompts } from "./terminal-prompts.js";
export { SetupCancelledError } from "./types.js";
export type { SetupChoice, SetupPrompts } from "./types.js";
export {
  mergeSetupConfig,
  rollbackSetupConfig,
  upsertTomlSection,
  writeSetupConfig,
} from "./config-writer.js";
