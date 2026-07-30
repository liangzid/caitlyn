/**
 * CAITLYN Daemon — Entry Point
 *
 * Started by `caitlyn daemon start`. Runs the HTTP server in the background.
 * Usage: node dist/daemon-entry.js [--port 9070]
 */

import { DaemonServer } from "./daemon/server.js";
import { writePidFile, removePidFile } from "./daemon/lifecycle.js";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? parseInt(args[portArg + 1], 10) || 9070 : 9070;

const server = new DaemonServer({ port });

process.on("SIGTERM", async () => {
  await server.stop();
  removePidFile();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await server.stop();
  removePidFile();
  process.exit(0);
});

try {
  await server.start();
  writePidFile();
  // Keep process alive
  process.stdin.resume();
} catch (err) {
  console.error("Failed to start daemon:", err);
  process.exit(1);
}
