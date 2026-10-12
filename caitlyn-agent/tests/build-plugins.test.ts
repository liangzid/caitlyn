/**
 * Plugin staging must use Node fs so Windows cmd.exe can run npm run build-plugins.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { copyPluginBuildAssets, PLUGIN_COPY_JOBS } from "../scripts/build-plugins.mjs";

describe("build-plugins", () => {
  it("copies each plugin source with Node fs instead of Unix mkdir/cp", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-build-plugins-"));
    try {
      for (const [fromRel] of PLUGIN_COPY_JOBS) {
        const from = path.join(root, fromRel);
        fs.mkdirSync(path.dirname(from), { recursive: true });
        fs.writeFileSync(from, `source:${path.basename(fromRel)}`, "utf-8");
      }
      copyPluginBuildAssets(root);
      for (const [fromRel, toRel] of PLUGIN_COPY_JOBS) {
        const to = path.join(root, toRel);
        expect(fs.existsSync(to)).toBe(true);
        expect(fs.readFileSync(to, "utf-8")).toBe(`source:${path.basename(fromRel)}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("wires package.json to the Node script", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf-8"),
    );
    expect(packageJson.scripts["build-plugins"]).toBe("node scripts/build-plugins.mjs");
    expect(packageJson.scripts["build-plugins"]).not.toMatch(/\bmkdir\b|\bcp\b/);
  });
});
