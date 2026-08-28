/**
 * CAITLYN — Public package API.
 *
 * The command-line tools remain the primary interface. These exports support
 * applications that install `caitlyn` as a local dependency and embed its
 * scanner or inspect its filesystem-native defense library.
 */

export { createCaitlynAgent } from "./agent.js";
export type { CaitlynAgentContext } from "./agent.js";

export { hybridScan } from "./hybrid-scanner.js";
export type { HybridScanOptions, HybridScanResult } from "./hybrid-scanner.js";

export {
  createUnavailableLlmCall,
  runTier0,
  scan,
  shutdownTier0Pool,
} from "./scanner.js";
export type { LlmCallFn, ScanOptions } from "./scanner.js";

export {
  loadAntibodies,
  loadAntigens,
  shippedLibraryRoot,
  userLibraryRoot,
} from "./library.js";

export type {
  AntibodyConfig,
  AntibodyEntry,
  AntigenConfig,
  AntigenEntry,
  ScanResult,
  ScriptResult,
  Verdict,
} from "./schema.js";
