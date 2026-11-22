/**
 * @jest-environment node
 */
// ============================================================
// Orderflow export: atomic writer and the API route
// ============================================================

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claimWriter, LEASE_MS, WRITER_PRIORITY, writeFileAtomic } from "@/lib/export/snapshotWriter";
import { POST } from "@/app/api/orderflow-export/route";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "orderflow-export-"));
  process.env.ORDERFLOW_EXPORT_DIR = path.join(dir, "orderflow"); // created on the first write
});

afterEach(() => {
  delete process.env.ORDERFLOW_EXPORT_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  test("creates the folder, writes the file and leaves no .tmp behind", async () => {
    const target = await writeFileAtomic(path.join(dir, "out"), "BTCUSDT.json", '{"a":1}');
    expect(readFileSync(target, "utf8")).toBe('{"a":1}');
    expect(readdirSync(path.join(dir, "out"))).toEqual(["BTCUSDT.json"]);
  });

  test("simultaneous writes to one file are queued, never sharing the .tmp", async () => {
    const out = path.join(dir, "out");
    await Promise.all(Array.from({ length: 8 }, (_, i) => writeFileAtomic(out, "BTCUSDT.json", JSON.stringify({ i }))));
    expect(JSON.parse(readFileSync(path.join(out, "BTCUSDT.json"), "utf8"))).toEqual({ i: 7 });
    expect(readdirSync(out)).toEqual(["BTCUSDT.json"]);
  });
});

describe("claimWriter (a lease file beside the export)", () => {
  const file = "BTCUSDT.json";
  const { dashboard, service } = WRITER_PRIORITY;

  test("one dashboard owns the file until it has been silent for the lease", async () => {
    expect(await claimWriter(dir, file, "writer-a", dashboard, 0)).toBe(true);
    expect(await claimWriter(dir, file, "writer-b", dashboard, 60_000)).toBe(false);
    expect(await claimWriter(dir, file, "writer-a", dashboard, 120_000)).toBe(true); // renews
    expect(await claimWriter(dir, file, "writer-b", dashboard, 120_000 + LEASE_MS + 1)).toBe(true); // takes over
    expect(await claimWriter(dir, file, "writer-a", dashboard, 120_000 + LEASE_MS + 2)).toBe(false);
  });

  test("the headless service takes over at once and outranks dashboards while it runs", async () => {
    expect(await claimWriter(dir, file, "dashboard-1", dashboard, 0)).toBe(true);
    expect(await claimWriter(dir, file, "service-1", service, 1_000)).toBe(true);
    expect(await claimWriter(dir, file, "dashboard-1", dashboard, 2_000)).toBe(false);
    // The service stopped: a dashboard takes over after the lease.
    expect(await claimWriter(dir, file, "dashboard-1", dashboard, 1_000 + LEASE_MS + 1)).toBe(true);
  });

  test("an unreadable lease file counts as free", async () => {
    writeFileSync(path.join(dir, `.${file}.writer`), "not json");
    expect(await claimWriter(dir, file, "writer-a", dashboard, 0)).toBe(true);
  });
});

describe("POST /api/orderflow-export", () => {
  const snapshot = { schema: "orderflow-snapshot/v1", symbol: "BTCUSDT", generatedAtMs: 1 };

  function post(body: unknown, headers: Record<string, string> = {}) {
    return POST(
      new Request("http://localhost:3000/api/orderflow-export", {
        method: "POST",
        headers: { "content-type": "application/json", "x-orderflow-writer": "writer-aaaa1111", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    );
  }

  test("writes <symbol>.json in ORDERFLOW_EXPORT_DIR", async () => {
    const response = await post(snapshot);
    expect(response.status).toBe(200);
    const file = path.join(dir, "orderflow", "BTCUSDT.json");
    expect(await response.json()).toMatchObject({ ok: true, file });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(snapshot);
  });

  test("rejects anything that is not a snapshot", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ schema: "other", symbol: "BTCUSDT" })).status).toBe(400);
    expect((await post({ ...snapshot, symbol: "../../evil" })).status).toBe(400);
    expect((await post(snapshot, { "x-orderflow-writer": "" })).status).toBe(400);
    expect(readdirSync(dir)).toEqual([]); // nothing written
  });

  test("refuses other sites' pages", async () => {
    expect((await post(snapshot, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post(snapshot, { "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  test("a second dashboard stands by while the first one writes", async () => {
    expect((await post(snapshot)).status).toBe(200);
    const second = await post({ ...snapshot, generatedAtMs: 2 }, { "x-orderflow-writer": "writer-bbbb2222" });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ standby: true });
    expect(JSON.parse(readFileSync(path.join(dir, "orderflow", "BTCUSDT.json"), "utf8")).generatedAtMs).toBe(1);
  });
});
