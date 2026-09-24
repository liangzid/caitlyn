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
import type { DefenseSkillEntry, AttackEntry } from "../schema.js";
import { loadDefenseSkills, loadAttacks } from "../library.js";
import { loadSyncSettings, saveSyncSettings } from "./settings.js";
import {
  hashPayload,
  sanitizeDefenseSkillConfig,
  sanitizeAttackConfig,
  scrubLocalPaths,
} from "./sanitize.js";
import {
  verifyAttackForContribute,
  verifyDefenseForContribute,
} from "./contribute-verify.js";

export interface ContributeSelection {
  defenseSkillIds: string[];
  attackIds: string[];
  /** Attack ids for which the full payload.txt is included. */
  includePayloadIds: string[];
}

export interface ContributeBundleResult {
  contribId: string;
  bundleRoot: string;
  incomingDir: string;
  defenseSkillsPacked: string[];
  attacksPacked: string[];
  blockedDefenseSkills: Array<{ id: string; errors: string[] }>;
  attackWarnings: Array<{ id: string; warnings: string[] }>;
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

function writeDefenseSkillConfigYaml(
  destDir: string,
  config: ReturnType<typeof sanitizeDefenseSkillConfig>,
): void {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (key === "stats") {
      lines.push("stats:");
      for (const [sk, sv] of Object.entries(config.stats)) {
        lines.push(`  ${sk}: ${sv}`);
      }
    } else if (key === "deps" || key === "execution_stages" || key === "runtime_requirements") {
      lines.push(`${key}:`);
      for (const item of value as string[]) lines.push(`  - ${yamlEscape(item)}`);
    } else if (key === "references") {
      if (config.references.length === 0) {
        lines.push("references: []");
        continue;
      }
      lines.push("references:");
      for (const ref of config.references) {
        lines.push(`  - title: ${yamlEscape(ref.title)}`);
        lines.push(`    url: ${yamlEscape(ref.url)}`);
        lines.push(`    year: ${ref.year}`);
      }
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

function writeAttackConfigYaml(
  destDir: string,
  config: ReturnType<typeof sanitizeAttackConfig>,
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
  const defenseSkills = loadDefenseSkills();
  const attacks = loadAttacks();
  if (defenseSkills.length === 0 && attacks.length === 0) {
    console.log("No local defense skills or attacks to contribute.");
    return null;
  }

  console.log("\nSelect entries to contribute (everything local is listed).\n");
  const defenseSkillIds: string[] = [];
  for (const ab of defenseSkills) {
    const take = await askYesNo(
      `  [defense skill] ${ab.config.id} (${ab.config.category}, tier ${ab.config.tier})`,
      false,
    );
    if (take) defenseSkillIds.push(ab.config.id);
  }

  const attackIds: string[] = [];
  const includePayloadIds: string[] = [];
  for (const ag of attacks) {
    const take = await askYesNo(
      `  [attack]  ${ag.config.id} (${ag.config.category})`,
      false,
    );
    if (!take) continue;
    attackIds.push(ag.config.id);
    const full = await askYesNo(
      `            include full payload.txt for ${ag.config.id}? (default: hashed)`,
      false,
    );
    if (full) includePayloadIds.push(ag.config.id);
  }

  if (defenseSkillIds.length === 0 && attackIds.length === 0) {
    console.log("Nothing selected.");
    return null;
  }
  return { defenseSkillIds, attackIds, includePayloadIds };
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
 * Defense failures hard-block those entries; attack warnings are recorded only.
 */
export async function packContributeBundle(
  selection: ContributeSelection,
): Promise<ContributeBundleResult> {
  const defenseSkills = loadDefenseSkills();
  const attacks = loadAttacks();
  const byAb = new Map(defenseSkills.map((a) => [a.config.id, a]));
  const byAg = new Map(attacks.map((a) => [a.config.id, a]));

  const blockedDefenseSkills: ContributeBundleResult["blockedDefenseSkills"] = [];
  const attackWarnings: ContributeBundleResult["attackWarnings"] = [];
  const acceptedAbs: DefenseSkillEntry[] = [];
  const acceptedAgs: Array<{ entry: AttackEntry; includePayload: boolean }> = [];

  for (const id of selection.defenseSkillIds) {
    const entry = byAb.get(id);
    if (!entry) {
      blockedDefenseSkills.push({ id, errors: ["not found in local library"] });
      continue;
    }
    const result = await verifyDefenseForContribute(entry);
    if (!result.ok) {
      blockedDefenseSkills.push({ id, errors: result.errors });
      continue;
    }
    acceptedAbs.push(entry);
  }

  for (const id of selection.attackIds) {
    const entry = byAg.get(id);
    if (!entry) {
      attackWarnings.push({ id, warnings: ["not found in local library"] });
      continue;
    }
    const soft = verifyAttackForContribute(entry);
    if (soft.warnings.length > 0) {
      attackWarnings.push({ id, warnings: soft.warnings });
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

  const defenseSkillsPacked: string[] = [];
  for (const entry of acceptedAbs) {
    const dest = path.join(incomingDir, "skills", entry.config.id);
    fs.mkdirSync(dest, { recursive: true });
    writeDefenseSkillConfigYaml(dest, sanitizeDefenseSkillConfig(entry.config));
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
    defenseSkillsPacked.push(entry.config.id);
  }

  const attacksPacked: string[] = [];
  for (const { entry, includePayload } of acceptedAgs) {
    const dest = path.join(incomingDir, "attacks", entry.config.id);
    fs.mkdirSync(dest, { recursive: true });
    writeAttackConfigYaml(dest, sanitizeAttackConfig(entry.config));
    fs.writeFileSync(
      path.join(dest, "README.md"),
      scrubLocalPaths(entry.readme || `# ${entry.config.id}\n`),
      "utf-8",
    );
    const payloadBody = includePayload
      ? entry.payload
      : hashPayload(entry.payload || "");
    fs.writeFileSync(path.join(dest, "payload.txt"), payloadBody, "utf-8");
    attacksPacked.push(entry.config.id);
  }

  const manifest = {
    contrib_id: contribId,
    created_at: new Date().toISOString(),
    defenseSkills: defenseSkillsPacked,
    attacks: attacksPacked,
    include_full_payload: selection.includePayloadIds.filter((id) =>
      attacksPacked.includes(id),
    ),
    blocked_defense_skills: blockedDefenseSkills,
    attack_warnings: attackWarnings,
    note:
      "Staging layout for human audit. Maintainers promote approved entries into skills/ and attacks/.",
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
    defenseSkillsPacked,
    attacksPacked,
    blockedDefenseSkills,
    attackWarnings,
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
    const defenseSkills = loadDefenseSkills();
    const attacks = loadAttacks();
    const includePayload = new Set(
      args
        .filter((a) => a.startsWith("--include-payload="))
        .flatMap((a) => a.slice("--include-payload=".length).split(","))
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (args.includes("--all")) {
      selection = {
        defenseSkillIds: defenseSkills.map((a) => a.config.id),
        attackIds: attacks.map((a) => a.config.id),
        includePayloadIds: [...includePayload],
      };
    } else if (idsFlag) {
      const ids = idsFlag
        .slice("--ids=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const abSet = new Set(defenseSkills.map((a) => a.config.id));
      const agSet = new Set(attacks.map((a) => a.config.id));
      selection = {
        defenseSkillIds: ids.filter((id) => abSet.has(id)),
        attackIds: ids.filter((id) => agSet.has(id)),
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
  console.log(`  Defense skills: ${result.defenseSkillsPacked.join(", ") || "(none)"}`);
  console.log(`  Attacks:   ${result.attacksPacked.join(", ") || "(none)"}`);
  if (result.blockedDefenseSkills.length > 0) {
    console.log("\nBlocked defenses (hard gate):");
    for (const b of result.blockedDefenseSkills) {
      console.log(`  - ${b.id}: ${b.errors.join("; ")}`);
    }
  }
  if (result.attackWarnings.length > 0) {
    console.log("\nAttack warnings (soft):");
    for (const w of result.attackWarnings) {
      console.log(`  - ${w.id}: ${w.warnings.join("; ")}`);
    }
  }
  console.log(
    "\nNext: open a PR that adds this tree under library/incoming/ in the caitlyn repo.\n" +
      "`gh pr create` automation lands in a follow-up; for now copy the incoming folder.",
  );
  if (
    result.defenseSkillsPacked.length === 0 &&
    result.attacksPacked.length === 0
  ) {
    process.exit(1);
  }
}
