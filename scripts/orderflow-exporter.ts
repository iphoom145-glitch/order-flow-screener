// ============================================================
// HEADLESS ORDERFLOW EXPORTER
// The dashboard's snapshot exporter as a Node service: no browser, no
// web server. It keeps its own background session on every perpetual
// venue and writes <ORDERFLOW_EXPORT_DIR>/<symbol>.json every interval.
// Meant for a container with a restart policy (see compose.yaml); it
// exits when nothing has been written for a while so it gets restarted.
//
//   npm run build:exporter && npm run start:exporter
//
// Environment:
//   ORDERFLOW_EXPORT_DIR           folder for the file (default Z:\Daily brief\orderflow)
//   ORDERFLOW_EXPORT_SYMBOL        default BTCUSDT
//   ORDERFLOW_EXPORT_INTERVAL_MS   default 60000
//   ORDERFLOW_STATE_DIR            folder for the history kept across restarts (unset: none)
//   ORDERFLOW_WRITER_ID            stable name of this writer (default the host name)
// ============================================================

import os from "node:os";
import { installApiShim } from "@/lib/export/nodeRuntime";
import { OrderflowExporter, type DeliverResult } from "@/lib/export/orderflowExporter";
import { WRITER_PRIORITY, claimWriter, exportDir, writeFileAtomic } from "@/lib/export/snapshotWriter";
import { loadState, saveState, stateFileName } from "@/lib/export/stateStore";

/** Restart (by exiting) when no file has been written for this long. */
const STALL_LIMIT_MS = 5 * 60_000;
/** Shutdown must not outlast Docker's stop grace period. */
const SHUTDOWN_LIMIT_MS = 8_000;

const log = (message: string) => console.log(`${new Date().toISOString()} [orderflow-exporter] ${message}`);
const warn = (message: string) => console.error(`${new Date().toISOString()} [orderflow-exporter] ${message}`);

installApiShim();

const symbol = (process.env.ORDERFLOW_EXPORT_SYMBOL || "BTCUSDT").toUpperCase();
const intervalMs = Number(process.env.ORDERFLOW_EXPORT_INTERVAL_MS) || 60_000;
const dir = exportDir();
const stateDir = process.env.ORDERFLOW_STATE_DIR?.trim() || null;
const fileName = `${symbol}.json`;
// A fixed name: a container recreated by an update is still the same writer.
const writer = `service-${process.env.ORDERFLOW_WRITER_ID || os.hostname()}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64);

const startedAt = Date.now();
let lastWrittenAt = 0;
let written = 0;
let saving: Promise<void> | null = null;

async function deliver(_snapshot: unknown, body: string): Promise<DeliverResult> {
  if (!(await claimWriter(dir, fileName, writer, WRITER_PRIORITY.service))) return "standby";
  await writeFileAtomic(dir, fileName, body);
  lastWrittenAt = Date.now();
  written++;
  if (written === 1 || written % 60 === 0) log(`wrote ${fileName} (${Buffer.byteLength(body, "utf8")} bytes, ${written} writes)`);
  void persist();
  return "written";
}

const exporter = new OrderflowExporter({ symbol, intervalMs, deliver });

/** Save the recorded history; a failure is logged and tried again after the next export. */
function persist(): Promise<void> {
  if (!stateDir) return Promise.resolve();
  if (saving) return saving;
  saving = saveState(stateDir, stateFileName(symbol), exporter.exportState())
    .then(() => {})
    .catch((error: unknown) => warn(`saving the history failed: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      saving = null;
    });
  return saving;
}

async function main(): Promise<void> {
  if (stateDir) {
    const restored = exporter.importState(await loadState(stateDir, stateFileName(symbol)));
    log(restored ? `restored ${restored} minutes of history from ${stateDir}` : `no usable history in ${stateDir}; starting fresh`);
  }
  exporter.start();
  log(`started: ${symbol} every ${Math.round(intervalMs / 1000)} s → ${dir}`);
}

const watchdog = setInterval(() => {
  const idle = Date.now() - Math.max(lastWrittenAt, startedAt);
  if (idle > STALL_LIMIT_MS) {
    warn(`nothing written for ${Math.round(idle / 1000)} s; exiting so the service restarts`);
    process.exit(1);
  }
}, 30_000);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down`);
  clearInterval(watchdog);
  const deadline = setTimeout(() => process.exit(0), SHUTDOWN_LIMIT_MS);
  await saving?.catch(() => {}); // a save already running
  saving = null;
  await persist(); // the latest minutes
  exporter.dispose();
  clearTimeout(deadline);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => console.error("[orderflow-exporter] unhandled rejection:", reason));
process.on("uncaughtException", (error) => {
  console.error("[orderflow-exporter] uncaught exception:", error);
  process.exit(1);
});

main().catch((error: unknown) => {
  console.error("[orderflow-exporter] could not start:", error);
  process.exit(1);
});
