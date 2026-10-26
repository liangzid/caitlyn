/**
 * CAITLYN Daemon — Barrel Export
 */
export {
  DaemonServer,
  DEFAULT_OCCUPANCY_POLL_MS,
  DEFAULT_COMPONENT_POLL_MS,
  type DaemonConfig,
  type DaemonStatus,
} from "./server.js";
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
  getOsWatchTick,
  getHostWatchDashboard,
  type DaemonHealth,
  type WatchInfo,
} from "./client.js";
