// ============================================================
// SNAPSHOT WRITER (server only)
// Writes the orderflow snapshot atomically: the JSON goes to
// <file>.tmp first and is then renamed over the real file, so a reader
// never sees a half-written file. Writes to one file are queued, so two
// requests never share the .tmp. Used by app/api/orderflow-export (a
// dashboard in a browser) and scripts/orderflow-exporter (the headless
// service).
// ============================================================

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Where the "BTC Market Brief" task looks; override with ORDERFLOW_EXPORT_DIR. */
export const DEFAULT_EXPORT_DIR = "Z:\\Daily brief\\orderflow";

export function exportDir(): string {
  return process.env.ORDERFLOW_EXPORT_DIR?.trim() || DEFAULT_EXPORT_DIR;
}

const RENAME_ATTEMPTS = 5;

/** A reader holding the file open (Windows) makes the rename fail briefly. */
function isTransient(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeNow(target: string, content: string): Promise<string> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await writeFile(temp, content, "utf8");
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(temp, target);
      return target;
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !isTransient(error)) {
        await unlink(temp).catch(() => {});
        throw error;
      }
      await sleep(100 * attempt);
    }
  }
}

const queues = new Map<string, Promise<unknown>>();

/** Write `content` to `dir/fileName` via `fileName.tmp` + rename. Returns the final path. */
export function writeFileAtomic(dir: string, fileName: string, content: string): Promise<string> {
  const target = path.join(dir, fileName);
  const previous = queues.get(target) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => writeNow(target, content));
  queues.set(target, next);
  void next.finally(() => {
    if (queues.get(target) === next) queues.delete(target);
  }).catch(() => {});
  return next;
}

// ----------------------------------------------------------
// Writer lease
// Several processes may want to write the same file: the headless service
// (highest priority) and any dashboard open in a browser. The current
// writer is recorded in a small file beside the export; the others stand by.
// A higher priority takes over at once; the same or a lower one only once
// the writer has been silent for LEASE_MS.
// ----------------------------------------------------------
export const LEASE_MS = 3 * 60_000;

export const WRITER_PRIORITY = { dashboard: 0, service: 10 } as const;

interface WriterLease {
  writer: string;
  priority: number;
  at: number;
}

function parseLease(text: string): WriterLease | null {
  try {
    const lease = JSON.parse(text) as Partial<WriterLease>;
    if (typeof lease.writer !== "string" || typeof lease.at !== "number" || !Number.isFinite(lease.at)) return null;
    return { writer: lease.writer, at: lease.at, priority: typeof lease.priority === "number" ? lease.priority : 0 };
  } catch {
    return null;
  }
}

/** True when `writer` may write `dir/fileName` now (and records it as the writer). */
export async function claimWriter(
  dir: string,
  fileName: string,
  writer: string,
  priority: number = WRITER_PRIORITY.dashboard,
  now = Date.now()
): Promise<boolean> {
  const leaseName = `.${fileName}.writer`;
  let lease: WriterLease | null = null;
  try {
    lease = parseLease(await readFile(path.join(dir, leaseName), "utf8"));
  } catch {
    lease = null; // nobody has written yet
  }
  const fresh = lease !== null && now - lease.at <= LEASE_MS;
  if (lease && lease.writer !== writer && fresh && lease.priority >= priority) return false;
  await writeFileAtomic(dir, leaseName, JSON.stringify({ writer, priority, at: now } satisfies WriterLease));
  return true;
}
