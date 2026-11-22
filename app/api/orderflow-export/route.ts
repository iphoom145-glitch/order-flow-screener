// Receives the dashboard's orderflow snapshot and writes it to disk for
// scheduled tasks that can read files but cannot call a localhost API.
//
//   POST /api/orderflow-export   body: orderflow-snapshot/v1 JSON
//   → <ORDERFLOW_EXPORT_DIR>/<symbol>.json, replaced atomically
//
// Only same-origin browser requests are accepted, the body is capped and
// must carry the snapshot schema, and the file name comes from a checked
// symbol, so a request can never choose where it writes.
//
// Every exporter identifies itself (X-Orderflow-Writer). When the
// dashboard is open in several places, the first writer owns the file and
// the others get 409 until it has been silent for a few minutes; the
// headless service, when running, always owns it.

import { SNAPSHOT_SCHEMA } from "@/lib/export/orderflowSnapshot";
import { WRITER_PRIORITY, claimWriter, exportDir, writeFileAtomic } from "@/lib/export/snapshotWriter";

const MAX_BYTES = 1024 * 1024;
const SYMBOL = /^[A-Z0-9]{2,20}$/;
const WRITER = /^[A-Za-z0-9-]{8,64}$/;

export async function POST(request: Request) {
  // Browsers send Sec-Fetch-Site; refuse writes from other sites' pages.
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") {
    return Response.json({ ok: false, error: "Cross-site requests are not accepted" }, { status: 403 });
  }
  const writer = request.headers.get("x-orderflow-writer") ?? "";
  if (!WRITER.test(writer)) return Response.json({ ok: false, error: "Missing X-Orderflow-Writer" }, { status: 400 });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) return Response.json({ ok: false, error: "Snapshot too large" }, { status: 413 });

  const text = await request.text();
  if (text.length > MAX_BYTES) return Response.json({ ok: false, error: "Snapshot too large" }, { status: 413 });

  let snapshot: { schema?: unknown; symbol?: unknown };
  try {
    snapshot = JSON.parse(text) as { schema?: unknown; symbol?: unknown };
  } catch {
    return Response.json({ ok: false, error: "Body is not JSON" }, { status: 400 });
  }
  if (snapshot?.schema !== SNAPSHOT_SCHEMA || typeof snapshot.symbol !== "string" || !SYMBOL.test(snapshot.symbol)) {
    return Response.json({ ok: false, error: `Expected an ${SNAPSHOT_SCHEMA} snapshot` }, { status: 400 });
  }

  const fileName = `${snapshot.symbol}.json`;
  const content = JSON.stringify(snapshot);
  try {
    if (!(await claimWriter(exportDir(), fileName, writer, WRITER_PRIORITY.dashboard))) {
      return Response.json({ ok: false, standby: true, error: "Another writer owns this file" }, { status: 409 });
    }
    const file = await writeFileAtomic(exportDir(), fileName, content);
    return Response.json({ ok: true, file, bytes: Buffer.byteLength(content, "utf8") });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[orderflow-export] write failed:", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
