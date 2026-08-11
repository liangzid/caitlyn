/**
 * CAITLYN — Tier 0 Resident Worker (server mode)
 *
 * A single long-lived Node process that loads every Tier 0 detector
 * module (detect.mjs) once and serves scan requests over stdin/stdout.
 * This removes per-scan process startup (~40-55ms per detector) and makes
 * the ~90ms Tier 0 floor essentially free.
 *
 * Protocol (one JSON object per line, both directions):
 *   request:  {"reqId":number,"id":"<antibody id>","content":"<text>"}
 *   response: {"reqId":number,"ok":true,"result":{verdict,confidence,reason}}
 *             {"reqId":number,"ok":false,"error":"<message>"}
 *   ready:    {"ready":true,"loaded":<n>}
 *
 * Usage: node tier0-worker.mjs --detector <id>=<path> [--detector ...]
 */

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";

const detectors = new Map();

for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith("--detector=")) continue;
  const pair = arg.slice("--detector=".length);
  const eq = pair.indexOf("=");
  if (eq <= 0) continue;
  const id = pair.slice(0, eq);
  const file = pair.slice(eq + 1);
  if (!fs.existsSync(file)) continue;
  // Only load modules that actually export a detect() function. Plain
  // top-level scripts (e.g. test fixtures) must not be imported here:
  // their side effects would pollute the protocol stream.
  const source = fs.readFileSync(file, "utf-8");
  if (!/export\s+(async\s+)?function\s+detect\s*\(/.test(source)) continue;
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.detect === "function") detectors.set(id, mod.detect);
  } catch {
    // Broken detector modules are skipped; the parent falls back to the
    // one-shot spawn path for them.
  }
}

function respond(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

process.stdout.write(JSON.stringify({ ready: true, loaded: detectors.size }) + "\n");

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (!req || typeof req.reqId !== "number") return;

  const detect = detectors.get(req.id);
  if (typeof detect !== "function") {
    respond({ reqId: req.reqId, ok: false, error: `detector not loaded: ${req.id}` });
    return;
  }

  Promise.resolve()
    .then(() => detect(String(req.content ?? "")))
    .then(
      (result) => respond({ reqId: req.reqId, ok: true, result }),
      (err) =>
        respond({
          reqId: req.reqId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
    );
});
