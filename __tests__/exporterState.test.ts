/**
 * @jest-environment node
 */
// ============================================================
// The exporter's history across restarts: the recorded minutes and the
// recent events are saved and loaded back; minutes while it was stopped
// stay missing.
// ============================================================

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OrderflowExporter } from "@/lib/export/orderflowExporter";
import { MinuteFlow, windowStats, WINDOWS, type SavedFlow, type SnapshotEvent } from "@/lib/export/orderflowSnapshot";
import { loadState, saveState, stateFileName } from "@/lib/export/stateStore";
import type { NormalizedLiquidation, NormalizedTrade, Venue } from "@/lib/types/market";

const M = 60_000;
const T0 = Date.UTC(2026, 10, 22, 0, 0, 0);

function trade(id: string, timestamp: number, price: number, quantity: number, side: "buy" | "sell", venue: Venue = "binance-futures"): NormalizedTrade {
  return { id, venue, symbol: "BTCUSDT", timestamp, localTimestamp: timestamp, price, quantity, quoteVolume: price * quantity, side, marketType: "perpetual" };
}

function liquidation(id: string, timestamp: number): NormalizedLiquidation {
  return { id, venue: "okx-futures", symbol: "BTCUSDT", timestamp, localTimestamp: timestamp, price: 60_010, quantity: 5, quoteVolume: 300_050, side: "long" };
}

/** Live from T0 for `minutes` minutes with trades, open interest, a liquidation and a block print. */
function recorded(minutes: number, bigPrintUsd = 100_000): MinuteFlow {
  const flow = new MinuteFlow(10, bigPrintUsd);
  for (let m = 0; m < minutes; m++) {
    const t = T0 + m * M;
    flow.markCovered(t + 1_000);
    flow.addTrade(trade(`t${m}`, t + 5_000, 60_000 + (m % 7), 0.5, m % 3 ? "sell" : "buy"));
    flow.addTrade(trade(`u${m}`, t + 25_000, 60_020 + (m % 5), 0.25, "buy", "bybit-futures"));
    flow.setOpenInterest(t + 30_000, 1e9 + m * 1e6);
  }
  if (minutes > 10) {
    flow.addTrade(trade("block", T0 + 10 * M + 40_000, 60_050, 4, "sell"));
    flow.addLiquidation(liquidation("liq", T0 + 11 * M + 5_000));
  }
  return flow;
}

const roundTrip = (flow: MinuteFlow): SavedFlow => JSON.parse(JSON.stringify(flow.save())) as SavedFlow;
const allWindows = (flow: MinuteFlow, now: number) =>
  WINDOWS.map((w) => windowStats(flow, now, w.durationMs, w.bucketMs, { currentOiUSD: 1.2e9, valueAreaPct: 0.7 }));

describe("MinuteFlow save / restore", () => {
  const now = T0 + 90 * M + 20_000;

  test("every window is identical after a save, a restart and a load", () => {
    const before = recorded(90);
    const after = new MinuteFlow(10, 100_000);
    expect(after.restore(roundTrip(before), now)).toBe(90);
    expect(allWindows(after, now)).toEqual(allWindows(before, now));
    expect(after.coveredSince).toBe(T0);
  });

  test("new minutes carry on from the restored ones; the stopped minutes stay missing", () => {
    const flow = new MinuteFlow(10, 100_000);
    flow.restore(roundTrip(recorded(60)), now); // recorded 00:00–00:59
    for (let m = 70; m < 80; m++) flow.markCovered(T0 + m * M + 1_000); // stopped 01:00–01:09
    const w = windowStats(flow, T0 + 79 * M + 30_000, 60 * M, 5 * M, { currentOiUSD: null, valueAreaPct: 0.7 });
    expect(w.coverageMin).toBe(50); // minutes 20–59 and 70–79; 60–69 are missing
    expect(w.complete).toBe(false);
  });

  test("another price bucket, old or future minutes and minutes already there are ignored", () => {
    const saved = roundTrip(recorded(5));
    expect(new MinuteFlow(5, 100_000).restore(saved, now)).toBe(0); // levels would not line up
    expect(new MinuteFlow(10, 100_000).restore(saved, T0 + 26 * 60 * M)).toBe(0); // older than 25 h
    expect(new MinuteFlow(10, 100_000).restore(saved, T0 - 60 * M)).toBe(0); // in the future

    const live = new MinuteFlow(10, 100_000);
    live.addTrade(trade("now", T0 + 2 * M + 1_000, 61_000, 1, "buy"));
    expect(live.restore(saved, now)).toBe(4); // minute 2 exists already
    expect(live.get(T0 + 2 * M)!.volume).toBe(1);
  });

  test("big-print counts are dropped when the threshold changed", () => {
    const same = new MinuteFlow(10, 100_000);
    same.restore(roundTrip(recorded(60)), now);
    const changed = new MinuteFlow(10, 200_000);
    changed.restore(roundTrip(recorded(60)), now);
    const count = (f: MinuteFlow) => windowStats(f, now, 24 * 60 * M, 60 * M, { currentOiUSD: null, valueAreaPct: 0.7 }).bigPrints.count;
    expect(count(same)).toBe(1);
    expect(count(changed)).toBe(0);
  });

  test("malformed minutes are skipped", () => {
    const saved = roundTrip(recorded(3));
    saved.minutes.push(null as never, { start: "x" } as never, { start: T0 + 12_345 } as never);
    expect(new MinuteFlow(10, 100_000).restore(saved, now)).toBe(3);
    expect(new MinuteFlow(10, 100_000).restore(null as never, now)).toBe(0);
  });
});

describe("OrderflowExporter state", () => {
  const exporter = () => new OrderflowExporter({ deliver: async () => "written" });
  const flowOf = (e: OrderflowExporter) => (e as unknown as { flow: MinuteFlow }).flow;
  const bigPrints = (e: OrderflowExporter) => (e as unknown as { bigPrints: SnapshotEvent[] }).bigPrints;
  const now = Date.now();
  const minute = Math.floor(now / M) * M;

  test("restores the minutes and the recent events, and says so in the health notes", () => {
    const first = exporter();
    for (let m = 10; m > 0; m--) {
      flowOf(first).markCovered(minute - m * M + 1_000);
      flowOf(first).addTrade(trade(`s${m}`, minute - m * M + 2_000, 60_000, 1, "buy"));
    }
    bigPrints(first).push({ type: "bigPrint", side: "sell", price: 60_000, sizeBase: 10, usd: 600_000, venue: "okx", tMs: minute - 3 * M, note: "block" });
    const state = JSON.parse(JSON.stringify(first.exportState(now)));

    const second = exporter();
    expect(second.importState(state, now)).toBe(10);
    expect(second.snapshot(now).windows["1h"].coverageMin).toBe(10);
    expect(second.snapshot(now).events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "bigPrint", note: "block" })]));
    expect(second.snapshot(now).health.notes.some((n) => n.startsWith("10 minutes of history from before a restart were restored"))).toBe(true);
    // Saved again by the second exporter, the event is still there.
    expect(JSON.parse(JSON.stringify(second.exportState(now))).events).toHaveLength(1);
  });

  test("ignores a state for another symbol, another version, or nothing at all", () => {
    const state = exporter().exportState(now);
    expect(exporter().importState({ ...state, symbol: "ETHUSDT" }, now)).toBe(0);
    expect(exporter().importState({ ...state, version: 2 }, now)).toBe(0);
    expect(exporter().importState(null, now)).toBe(0);
    expect(exporter().importState("nonsense", now)).toBe(0);
  });
});

describe("state file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "orderflow-state-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("round-trips gzipped, and is replaced atomically", async () => {
    const file = stateFileName("BTCUSDT");
    expect(file).toBe("BTCUSDT.state.json.gz");
    const state = { version: 1, symbol: "BTCUSDT", flow: roundTrip(recorded(60)) };
    const bytes = await saveState(dir, file, state);
    expect(readFileSync(path.join(dir, file)).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b])); // gzip
    expect(bytes).toBeLessThan(JSON.stringify(state).length);
    expect(await loadState(dir, file)).toEqual(state);
    await saveState(dir, file, { ...state, savedAt: 2 });
    expect(await loadState(dir, file)).toMatchObject({ savedAt: 2 });
  });

  test("a missing or damaged file is simply no state", async () => {
    expect(await loadState(dir, "missing.gz")).toBeNull();
    writeFileSync(path.join(dir, "bad.gz"), "not gzip");
    expect(await loadState(dir, "bad.gz")).toBeNull();
  });
});
