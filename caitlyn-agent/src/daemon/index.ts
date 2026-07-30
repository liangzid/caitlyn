/**
 * CAITLYN Daemon — Barrel Export
 */
export { DaemonServer, type DaemonConfig, type DaemonStatus } from "./server.js";
export {
  isDaemonRunning,
  getDaemonPid,
  startDaemon,
  stopDaemon,
  daemonStatus,
  writePidFile,
  removePidFile,
} from "./lifecycle.js";
export {
  isDaemonAvailable,
  getHealth,
  daemonScan,
  getDaemonStatus,
  daemonWatch,
  getWatchInfo,
  daemonUnwatch,
  type DaemonHealth,
  type WatchInfo,
} from "./client.js";
