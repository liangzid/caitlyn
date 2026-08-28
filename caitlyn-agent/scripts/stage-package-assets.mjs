#!/usr/bin/env node
/**
 * CAITLYN — Stage the curated defense library inside the npm package.
 *
 * The canonical libraries live at the repository root, outside the npm
 * package directory. `npm pack` can only include files below this directory,
 * so prepack creates short-lived package-local copies. Postpack removes them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "..");
const projectRoot = path.resolve(packageRoot, "..");
const resourceDirectories = ["antibodies", "antigens"];

/** Return false for local state that must never enter a published package. */
function isPublishableResource(sourcePath) {
  const relativePath = path.relative(projectRoot, sourcePath);
  const segments = relativePath.split(path.sep);
  const basename = path.basename(sourcePath);
  return (
    !segments.includes(".trash") &&
    basename !== "tsconfig.detect.json" &&
    !basename.endsWith("~")
  );
}

/** Remove the generated package-local library directories. */
function cleanStagedResources() {
  for (const directoryName of resourceDirectories) {
    fs.rmSync(path.join(packageRoot, directoryName), {
      recursive: true,
      force: true,
    });
  }
}

/** Copy one canonical resource directory into the npm package staging area. */
function stageResourceDirectory(directoryName) {
  const sourceDirectory = path.join(projectRoot, directoryName);
  const targetDirectory = path.join(packageRoot, directoryName);
  if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
    throw new Error(`Missing canonical resource directory: ${sourceDirectory}`);
  }
  fs.cpSync(sourceDirectory, targetDirectory, {
    recursive: true,
    filter: isPublishableResource,
  });
}

/** Count immediate entry directories containing a config file. */
function countConfiguredEntries(directoryName) {
  const directory = path.join(packageRoot, directoryName);
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(directory, entry.name, "config.yaml")))
    .length;
}

/** Validate that the staged library is complete enough for an installed CLI. */
function validateStagedResources() {
  const antibodyCount = countConfiguredEntries("antibodies");
  const antigenCount = countConfiguredEntries("antigens");
  const indexPath = path.join(packageRoot, "antibodies", "index.json");
  if (antibodyCount === 0 || antigenCount === 0 || !fs.existsSync(indexPath)) {
    throw new Error(
      `Incomplete package library: ${antibodyCount} antibodies, ${antigenCount} antigens`,
    );
  }
  console.log(
    `Staged npm library: ${antibodyCount} antibodies, ${antigenCount} antigens`,
  );
}

if (process.argv.includes("--clean")) {
  cleanStagedResources();
  process.exit(0);
}

cleanStagedResources();
for (const directoryName of resourceDirectories) {
  stageResourceDirectory(directoryName);
}
validateStagedResources();
