// ============================================================
// STATE STORE (headless service only)
// The exporter's recorded minutes and recent events, saved as gzipped
// JSON so a restart carries on instead of starting the windows over.
// Written the same atomic way as the snapshot. A missing or unreadable
// state file just means starting fresh.
// ============================================================

import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { writeFileAtomic } from "./snapshotWriter";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const stateFileName = (symbol: string): string => `${symbol}.state.json.gz`;

/** Save `state`; returns the compressed size in bytes. */
export async function saveState(dir: string, fileName: string, state: unknown): Promise<number> {
  const packed = await gzipAsync(Buffer.from(JSON.stringify(state), "utf8"));
  await writeFileAtomic(dir, fileName, packed);
  return packed.length;
}

/** The saved state, or null when there is none or it cannot be read. */
export async function loadState(dir: string, fileName: string): Promise<unknown> {
  try {
    const packed = await readFile(path.join(dir, fileName));
    return JSON.parse((await gunzipAsync(packed)).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}
