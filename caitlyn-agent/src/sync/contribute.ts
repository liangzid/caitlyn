/**
 * CAITLYN — Pack selected library entries into library/incoming/ layout.
 *
 * v1 writes a local PR-ready bundle under ~/.caitlyn/contribute/.
 * Opening a GitHub PR via `gh` is deferred to a follow-up.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { AntibodyEntry, AntigenEntry } from "../schema.js";
import { loadAntibodies, loadAntigens } from "../library.js";
import { loadSyncSettings, saveSyncSettings } from "./settings.js";
import {
  hashPayload,
  sanitizeAntibodyConfig,
  sanitizeAntigenConfig,
  scrubLocalPaths,
} from "./sanitize.js";
import {
  verifyAntigenForContribute,
  verifyDefenseForContribute,
} from "./contribute-verify.js";

export interface ContributeSelection {
  antibodyIds: string[];
  antigenIds: string[];
  /** Antigen ids for which the full payload.txt is included. */
  includePayloadIds: string[];
}

export interface ContributeBundleResult {
  contribId: string;
  bundleRoot: string;
  incomingDir: string;
  antibodiesPacked: string[];
  antigensPacked: string[];
  blockedAntibodies: Array<{ id: string; errors: string[] }>;
  antigenWarnings: Array<{ id: string; warnings: string[] }>;
}

function contributeHome(): string {
  if (process.env.CAITLYN_CONTRIBUTE_DIR) {
    return path.resolve(process.env.CAITLYN_CONTRIBUTE_DIR);
  }
  return path.join(os.homedir(), ".caitlyn", "contribute");
}

function makeContribId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `contrib-${stamp}-${rand}`;
}

function yamlEscape(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  const s = String(value);
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function writeAntibodyConfigYaml(
  destDir: string,
  config: ReturnType<typeof sanitizeAntibodyConfig>,
): void {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (key === "stats") {
      lines.push("stats:");
      for (const [sk, sv] of Object.entries(config.stats)) {
        lines.push(`  ${sk}: ${sv}`);
      }
    } else if (key === "deps") {
      lines.push("deps:");
      for (const d of config.deps) lines.push(`  - ${yamlEscape(d)}`);
    } else if (key === "signatures") {
      lines.push("signatures:");
      for (const sig of config.signatures) {
        lines.push(`  - pattern: ${yamlEscape(sig.pattern)}`);
        lines.push(`    type: ${yamlEscape(sig.type)}`);
        lines.push(`    label: ${yamlEscape(sig.label)}`);
      }
    } else {
      lines.push(`${key}: ${yamlEscape(value)}`);
    }
  }
  fs.writeFileSync(path.join(destDir, "config.yaml"), lines.join("\n"), "utf-8");
}

function writeAntigenConfigYaml(
  destDir: string,
  config: ReturnType<typeof sanitizeAntigenConfig>,
): void {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (key === "escapes") {
      lines.push("escapes:");
      for (const e of config.escapes) lines.push(`  - ${yamlEscape(e)}`);
    } else {
      lines.push(`${key}: ${yamlEscape(value)}`);
    }
  }
  fs.writeFileSync(path.join(destDir, "config.yaml"), lines.join("\n"), "utf-8");
}

/**
 * Ask yes/no on stdin. Default follows `defaultYes`.
 */
async function askYesNo(prompt: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${prompt} [${hint}]: `, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

/**
 * Interactive picker over the full local library (paper Option C).
 */
export async function pickContributeSelectionInteractive(): Promise<ContributeSelection | null> {
  const antibodies = loadAntibodies();
  const antigens = loadAntigens();
  if (antibodies.length === 0 && antigens.length === 0) {
    console.log("No local antibodies or antigens to contribute.");
    return null;
  }

  console.log("\nSelect entries to contribute (everything local is listed).\n");
  const antibodyIds: string[] = [];
  for (const ab of antibodies) {
    const take = await askYesNo(
      `  [antibody] ${ab.config.id} (${ab.config.category}, tier ${ab.config.tier})`,
      false,
    );
    if (take) antibodyIds.push(ab.config.id);
  }

  const antigenIds: string[] = [];
  const includePayloadIds: string[] = [];
  for (const ag of antigens) {
    const take = await askYesNo(
      `  [antigen]  ${ag.config.id} (${ag.config.category})`,
      false,
    );
    if (!take) continue;
    antigenIds.push(ag.config.id);
    const full = await askYesNo(
      `            include full payload.txt for ${ag.config.id}? (default: hashed)`,
      false,
    );
    if (full) includePayloadIds.push(ag.config.id);
  }

  if (antibodyIds.length === 0 && antigenIds.length === 0) {
    console.log("Nothing selected.");
    return null;
  }
  return { antibodyIds, antigenIds, includePayloadIds };
}

/**
 * Ensure contribute opt-in via a short first-run wizard.
 * Returns false if the user declines.
 */
export async function ensureContributeOptIn(): Promise<boolean> {
  const settings = loadSyncSettings();
  if (settings.contributeEnabled) return true;
  console.log(
    "Cloud contribution is off by default. Enabling lets CAITLYN pack local\n" +
      "attack/defense entries for human audit (library/incoming/). Nothing is\n" +
      "uploaded automatically in this version — a local bundle is written.",
  );
  const ok = await askYesNo("Enable contribution packing on this machine?", false);
  if (!ok) {
    console.log("Contribute cancelled (still disabled).");
    return false;
  }
  saveSyncSettings({ contributeEnabled: true });
  console.log("Opt-in saved to ~/.caitlyn/settings.toml");
  return true;
}

/**
 * Pack selected entries into ~/.caitlyn/contribute/<id>/library/incoming/<id>/.
 * Defense failures hard-block those entries; antigen warnings are recorded only.
 */
export async function packContributeBundle(
  selection: ContributeSelection,
): Promise<ContributeBundleResult> {
  const antibodies = loadAntibodies();
  const antigens = loadAntigens();
  const byAb = new Map(antibodies.map((a) => [a.config.id, a]));
  const byAg = new Map(antigens.map((a) => [a.config.id, a]));

  const blockedAntibodies: ContributeBundleResult["blockedAntibodies"] = [];
  const antigenWarnings: ContributeBundleResult["antigenWarnings"] = [];
  const acceptedAbs: AntibodyEntry[] = [];
  const acceptedAgs: Array<{ entry: AntigenEntry; includePayload: boolean }> = [];

  for (const id of selection.antibodyIds) {
    const entry = byAb.get(id);
    if (!entry) {
      blockedAntibodies.push({ id, errors: ["not found in local library"] });
      continue;
    }
    const result = await verifyDefenseForContribute(entry);
    if (!result.ok) {
      blockedAntibodies.push({ id, errors: result.errors });
      continue;
    }
    acceptedAbs.push(entry);
  }

  for (const id of selection.antigenIds) {
    const entry = byAg.get(id);
    if (!entry) {
      antigenWarnings.push({ id, warnings: ["not found in local library"] });
      continue;
    }
    const soft = verifyAntigenForContribute(entry);
    if (soft.warnings.length > 0) {
      antigenWarnings.push({ id, warnings: soft.warnings });
    }
    acceptedAgs.push({
      entry,
      includePayload: selection.includePayloadIds.includes(id),
    });
  }

  const contribId = makeContribId();
  const bundleRoot = path.join(contributeHome(), contribId);
  const incomingDir = path.join(bundleRoot, "library", "incoming", contribId);
  fs.mkdirSync(incomingDir, { recursive: true });

  const antibodiesPacked: string[] = [];
  for (const entry of acceptedAbs) {
    const dest = path.join(incomingDir, "antibodies", entry.config.id);
    fs.mkdirSync(dest, { recursive: true });
    writeAntibodyConfigYaml(dest, sanitizeAntibodyConfig(entry.config));
    fs.writeFileSync(
      path.join(dest, "README.md"),
      scrubLocalPaths(entry.readme || `# ${entry.config.id}\n`),
      "utf-8",
    );
    for (const name of ["detect.ts", "detect.mjs"]) {
      const src = path.join(entry.folderPath, name);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(dest, name));
      }
    }
    antibodiesPacked.push(entry.config.id);
  }

  const antigensPacked: string[] = [];
  for (const { entry, includePayload } of acceptedAgs) {
    const dest = path.join(incomingDir, "antigens", entry.config.id);
    fs.mkdirSync(dest, { recursive: true });
    writeAntigenConfigYaml(dest, sanitizeAntigenConfig(entry.config));
    fs.writeFileSync(
      path.join(dest, "README.md"),
      scrubLocalPaths(entry.readme || `# ${entry.config.id}\n`),
      "utf-8",
    );
    const payloadBody = includePayload
      ? entry.payload
      : hashPayload(entry.payload || "");
    fs.writeFileSync(path.join(dest, "payload.txt"), payloadBody, "utf-8");
    antigensPacked.push(entry.config.id);
  }

  const manifest = {
    contrib_id: contribId,
    created_at: new Date().toISOString(),
    antibodies: antibodiesPacked,
    antigens: antigensPacked,
    include_full_payload: selection.includePayloadIds.filter((id) =>
      antigensPacked.includes(id),
    ),
    blocked_antibodies: blockedAntibodies,
    antigen_warnings: antigenWarnings,
    note:
      "Staging layout for human audit. Maintainers promote approved entries into antibodies/ and antigens/.",
  };
  fs.writeFileSync(
    path.join(incomingDir, "MANIFEST.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );

  return {
    contribId,
    bundleRoot,
    incomingDir,
    antibodiesPacked,
    antigensPacked,
    blockedAntibodies,
    antigenWarnings,
  };
}

/**
 * CLI entry: opt-in wizard → picker (or flags) → pack local bundle.
 */
export async function runContributeCommand(args: string[]): Promise<void> {
  if (!(await ensureContributeOptIn())) {
    process.exit(1);
  }

  let selection: ContributeSelection | null = null;
  const idsFlag = args.find((a) => a.startsWith("--ids="));
  if (idsFlag || args.includes("--all")) {
    const antibodies = loadAntibodies();
    const antigens = loadAntigens();
    const includePayload = new Set(
      args
        .filter((a) => a.startsWith("--include-payload="))
        .flatMap((a) => a.slice("--include-payload=".length).split(","))
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (args.includes("--all")) {
      selection = {
        antibodyIds: antibodies.map((a) => a.config.id),
        antigenIds: antigens.map((a) => a.config.id),
        includePayloadIds: [...includePayload],
      };
    } else if (idsFlag) {
      const ids = idsFlag
        .slice("--ids=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const abSet = new Set(antibodies.map((a) => a.config.id));
      const agSet = new Set(antigens.map((a) => a.config.id));
      selection = {
        antibodyIds: ids.filter((id) => abSet.has(id)),
        antigenIds: ids.filter((id) => agSet.has(id)),
        includePayloadIds: ids.filter((id) => includePayload.has(id)),
      };
    }
  } else {
    selection = await pickContributeSelectionInteractive();
  }

  if (!selection) {
    process.exit(1);
  }

  const result = await packContributeBundle(selection);
  console.log(`\nPacked contribution ${result.contribId}`);
  console.log(`  Bundle: ${result.bundleRoot}`);
  console.log(`  Incoming: ${result.incomingDir}`);
  console.log(`  Antibodies: ${result.antibodiesPacked.join(", ") || "(none)"}`);
  console.log(`  Antigens:   ${result.antigensPacked.join(", ") || "(none)"}`);
  if (result.blockedAntibodies.length > 0) {
    console.log("\nBlocked defenses (hard gate):");
    for (const b of result.blockedAntibodies) {
      console.log(`  - ${b.id}: ${b.errors.join("; ")}`);
    }
  }
  if (result.antigenWarnings.length > 0) {
    console.log("\nAntigen warnings (soft):");
    for (const w of result.antigenWarnings) {
      console.log(`  - ${w.id}: ${w.warnings.join("; ")}`);
    }
  }
  console.log(
    "\nNext: open a PR that adds this tree under library/incoming/ in the caitlyn repo.\n" +
      "`gh pr create` automation lands in a follow-up; for now copy the incoming folder.",
  );
  if (
    result.antibodiesPacked.length === 0 &&
    result.antigensPacked.length === 0
  ) {
    process.exit(1);
  }
}
