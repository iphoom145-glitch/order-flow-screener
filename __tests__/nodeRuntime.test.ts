/**
 * @jest-environment node
 */
// ============================================================
// Headless service: relative /api/ requests are answered in process
// by the app's own route handlers, with their allowlists intact.
// ============================================================

import { installApiShim } from "@/lib/export/nodeRuntime";

const original = globalThis.fetch;
let upstream: { url: string; method: string }[];
let restore: (() => void) | null;

beforeEach(() => {
  upstream = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    upstream.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  restore = installApiShim();
});

afterEach(() => {
  restore?.();
  globalThis.fetch = original;
});

describe("installApiShim", () => {
  it("routes the HTX adapter's contract request to HTX", async () => {
    const response = await fetch("/api/htx?op=contract&contract=BTC-USDT");
    expect(response.status).toBe(200);
    expect(upstream).toEqual([{ url: "https://api.hbdm.com/linear-swap-api/v1/swap_contract_info?contract_code=BTC-USDT", method: "GET" }]);
  });

  it("routes the KuCoin adapter's POST for a public token to KuCoin", async () => {
    const response = await fetch("/api/kucoin?op=bullet&market=futures", { method: "POST" });
    expect(response.status).toBe(200);
    expect(upstream).toEqual([{ url: "https://api-futures.kucoin.com/api/v1/bullet-public", method: "POST" }]);
  });

  it("keeps the routes' allowlists and rejects unknown routes", async () => {
    expect((await fetch("/api/htx?op=evil&contract=BTC-USDT")).status).toBe(400);
    expect((await fetch("/api/kucoin?op=contract&symbol=../x")).status).toBe(400);
    expect((await fetch("/api/unknown")).status).toBe(404);
    expect(upstream).toEqual([]); // nothing reached the network
  });

  it("passes every other request through and can be removed", async () => {
    await fetch("https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT");
    expect(upstream).toEqual([{ url: "https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT", method: "GET" }]);
    restore?.();
    restore = null;
    expect(globalThis.fetch).not.toBe(original); // the stub installed by this test, without the shim
  });
});
