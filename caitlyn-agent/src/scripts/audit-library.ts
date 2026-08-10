/**
 * CAITLYN — Antibody Library Integrity Audit
 *
 * Loads the real antibody library from disk and reports every entry that
 * is not executable by the scanner (missing detect.ts, signatures, or
 * prompt) plus duplicate ids/signatures. Exits non-zero on any issue.
 *
 * Usage: npm run audit:library
 */
import { loadAntibodies, checkLibraryIntegrity } from "../library.js";

const antibodies = loadAntibodies();
const issues = checkLibraryIntegrity(antibodies);

if (issues.length > 0) {
  console.error(`✗ antibody library integrity check failed (${issues.length} issue(s)):`);
  for (const issue of issues) {
    console.error(`  - ${issue}`);
  }
  process.exit(1);
}

console.log(
  `✓ antibody library integrity OK (${antibodies.length} antibodies, ` +
    `${antibodies.filter((a) => a.config.role === "detector").length} detectors)`,
);
