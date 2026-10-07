/**
 * CAITLYN — Defense skill Library Integrity Audit
 *
 * Loads the real defense skill library from disk and reports every entry that
 * is not executable by the scanner (missing detect.ts, signatures, or
 * prompt) plus duplicate ids/signatures. Exits non-zero on any issue.
 *
 * Usage: npm run audit:library
 */
import { loadDefenseSkills, checkLibraryIntegrity } from "../library.js";

const defenseSkills = loadDefenseSkills();
const issues = checkLibraryIntegrity(defenseSkills);

if (issues.length > 0) {
  console.error(`✗ defense skill library integrity check failed (${issues.length} issue(s)):`);
  for (const issue of issues) {
    console.error(`  - ${issue}`);
  }
  process.exit(1);
}

console.log(
  `✓ defense skill library integrity OK (${defenseSkills.length} defense skills, ` +
    `${defenseSkills.filter((a) => a.config.role === "detector").length} detectors)`,
);
