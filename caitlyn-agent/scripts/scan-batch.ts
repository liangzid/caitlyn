/**
 * Batch static scanner for the lifelong-synthesis experiment.
 *
 * Reads JSONL {id, content} rows and writes JSONL verdicts. Honors
 * CAITLYN_LIBRARY_DIR / CAITLYN_HISTORY_DIR / CAITLYN_STATS_DIR.
 *
 * Usage:
 *   npx tsx scripts/scan-batch.ts --input items.jsonl --output verdicts.jsonl
 *   npx tsx scripts/scan-batch.ts --input items.jsonl --output verdicts.jsonl --tier0-only
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createUnavailableLlmCall, type LlmCallFn } from "../src/scanner.js";
import { hybridScan } from "../src/hybrid-scanner.js";
import { makeEvolutionLlmPair } from "../src/commands/evolution.js";

interface ScanItem {
  id: string;
  content: string;
}

function parseArgs(argv: string[]): {
  input: string;
  output: string;
  tier0Only: boolean;
} {
  const args: Record<string, string> = {};
  let tier0Only = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--tier0-only") {
      tier0Only = true;
      continue;
    }
    if (token.startsWith("--") && i + 1 < argv.length) {
      args[token.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  if (!args.input || !args.output) {
    throw new Error("Usage: scan-batch.ts --input items.jsonl --output verdicts.jsonl [--tier0-only]");
  }
  return { input: args.input, output: args.output, tier0Only };
}

function loadItems(filePath: string): ScanItem[] {
  const items: ScanItem[] = [];
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as ScanItem;
    if (typeof row.id !== "string" || typeof row.content !== "string") {
      throw new Error(`invalid scan item: ${line.slice(0, 80)}`);
    }
    items.push(row);
  }
  return items;
}

function makeLlm(tier0Only: boolean): LlmCallFn {
  if (tier0Only) return createUnavailableLlmCall("tier0-only experiment mode");
  return makeEvolutionLlmPair().generator;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const items = loadItems(path.resolve(opts.input));
  const llmCall = makeLlm(opts.tier0Only);
  const outPath = path.resolve(opts.output);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const stream = fs.createWriteStream(outPath, { encoding: "utf-8" });

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const result = await hybridScan({ content: item.content, llmCall });
    // KEYPOINT-REVIEW: 5.2 blocked = malicious only, matching 5.1 e2e CaitlynDefense.
    const blocked = result.verdict === "malicious";
    const antibodies = result.script_results
      .filter((r) => r.verdict === "malicious")
      .map((r) => r.antibody_id);
    stream.write(
      `${JSON.stringify({
        id: item.id,
        verdict: result.verdict,
        blocked,
        antibodies,
        tier: result.tier,
        latency_ms: result.total_latency_us / 1000,
        tokens: result.total_tokens,
      })}\n`,
    );
    if ((i + 1) % 25 === 0 || i + 1 === items.length) {
      console.error(`scanned ${i + 1}/${items.length}`);
    }
  }
  stream.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
