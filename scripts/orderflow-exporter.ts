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
// ============================================================

import os from "node:os";
import { installApiShim } from "@/lib/export/nodeRuntime";
import { OrderflowExporter, type DeliverResult } from "@/lib/export/orderflowExporter";
import { WRITER_PRIORITY, claimWriter, exportDir, writeFileAtomic } from "@/lib/export/snapshotWriter";

/** Restart (by exiting) when no file has been written for this long. */
const STALL_LIMIT_MS = 5 * 60_000;

const log = (message: string) => console.log(`${new Date().toISOString()} [orderflow-exporter] ${message}`);

installApiShim();

const symbol = (process.env.ORDERFLOW_EXPORT_SYMBOL || "BTCUSDT").toUpperCase();
const intervalMs = Number(process.env.ORDERFLOW_EXPORT_INTERVAL_MS) || 60_000;
const dir = exportDir();
const fileName = `${symbol}.json`;
const writer = `service-${os.hostname()}-${process.pid}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64);

const startedAt = Date.now();
let lastWrittenAt = 0;
let written = 0;

async function deliver(_snapshot: unknown, body: string): Promise<DeliverResult> {
  if (!(await claimWriter(dir, fileName, writer, WRITER_PRIORITY.service))) return "standby";
  await writeFileAtomic(dir, fileName, body);
  lastWrittenAt = Date.now();
  written++;
  if (written === 1 || written % 60 === 0) log(`wrote ${fileName} (${Buffer.byteLength(body, "utf8")} bytes, ${written} writes)`);
  return "written";
}

const exporter = new OrderflowExporter({ symbol, intervalMs, deliver });
exporter.start();
log(`started: ${symbol} every ${Math.round(intervalMs / 1000)} s → ${dir}`);

const watchdog = setInterval(() => {
  const idle = Date.now() - Math.max(lastWrittenAt, startedAt);
  if (idle > STALL_LIMIT_MS) {
    console.error(`${new Date().toISOString()} [orderflow-exporter] nothing written for ${Math.round(idle / 1000)} s; exiting so the service restarts`);
    process.exit(1);
  }
}, 30_000);

function shutdown(signal: string): void {
  log(`${signal}: shutting down`);
  clearInterval(watchdog);
  exporter.dispose();
  setTimeout(() => process.exit(0), 250);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => console.error("[orderflow-exporter] unhandled rejection:", reason));
process.on("uncaughtException", (error) => {
  console.error("[orderflow-exporter] uncaught exception:", error);
  process.exit(1);
});
