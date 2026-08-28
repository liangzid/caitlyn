/**
 * Cluster vaccination entry for the lifelong-synthesis experiment.
 *
 * Feeds an antigen cluster (mustDetect[]) into EvolutionEngine and writes
 * the loop outcome as JSON. evolutionDir is taken from CAITLYN_EVOLUTION_DIR
 * or --evolution-dir. Does not touch the product `caitlyn vaccinate` CLI.
 *
 * Usage:
 *   npx tsx scripts/vaccinate-cluster.ts \
 *     --must-detect misses.json --benign benign.json \
 *     --cluster-id status_field --evolution-dir ./evolution \
 *     --out outcome.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEvolutionConfig } from "../src/config.js";
import { EvolutionEngine } from "../src/evolution/engine.js";
import { extractAntigenFeatures } from "../src/evolution/features.js";
import { makeEvolutionLlmPair } from "../src/commands/evolution.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--") && i + 1 < argv.length) {
      args[token.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function loadStringList(filePath: string): string[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) {
    throw new Error(`${filePath} must be a JSON array of strings`);
  }
  return raw;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mustPath = args["must-detect"];
  const benignPath = args.benign;
  const clusterId = args["cluster-id"];
  const outPath = args.out;
  if (!mustPath || !benignPath || !clusterId || !outPath) {
    throw new Error(
      "Usage: vaccinate-cluster.ts --must-detect misses.json --benign benign.json --cluster-id ID --out outcome.json [--evolution-dir DIR]",
    );
  }

  const mustDetect = loadStringList(path.resolve(mustPath));
  const benign = loadStringList(path.resolve(benignPath));
  if (mustDetect.length === 0) {
    const empty = {
      skipped: true,
      reason: "empty_must_detect",
      clusterId,
      approved: [],
      rounds: 0,
      tokensUsed: 0,
      termination: "skipped",
    };
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(empty, null, 2)}\n`);
    console.log(JSON.stringify(empty));
    return;
  }

  const evolutionDir = path.resolve(
    args["evolution-dir"] || process.env.CAITLYN_EVOLUTION_DIR || "",
  );
  if (!evolutionDir) {
    throw new Error("pass --evolution-dir or set CAITLYN_EVOLUTION_DIR");
  }
  fs.mkdirSync(evolutionDir, { recursive: true });

  // KEYPOINT-REVIEW: isolated DAG dir only. Do not fall back to ~/.caitlyn/evolution.
  const config = { ...loadEvolutionConfig(), evolutionDir };
  const { generator, reviewer } = makeEvolutionLlmPair();
  const engine = new EvolutionEngine({
    config,
    generatorLlm: generator,
    reviewerLlm: reviewer,
  });
  const outcome = await engine.run({
    clusterId,
    target: `lifelong wave cluster ${clusterId}`,
    profile: {
      clusterId,
      category: "emerging",
      features: extractAntigenFeatures(mustDetect),
      sampleCount: mustDetect.length,
    },
    mustDetect,
    benign,
    hasSamples: true,
  });

  const summary = {
    skipped: false,
    clusterId,
    mustDetectCount: mustDetect.length,
    benignCount: benign.length,
    rounds: outcome.loop.rounds,
    tokensUsed: outcome.loop.tokensUsed,
    termination: outcome.loop.termination,
    lessonsWritten: outcome.loop.lessonsWritten,
    approved: outcome.loop.approved.map((vc) => ({
      id: vc.draft.id,
      name: vc.draft.name,
      signatures: vc.draft.signatures,
    })),
    shadowStarted: outcome.shadowStarted,
  };
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
