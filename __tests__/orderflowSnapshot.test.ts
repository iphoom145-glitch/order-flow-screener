// ============================================================
// Orderflow snapshot (schema orderflow-snapshot/v1)
// ============================================================

import {
  MinuteFlow,
  bookSection,
  buildSnapshot,
  consensusMid,
  derivativesSection,
  isoWithOffset,
  leadStatus,
  liquidationClusters,
  mergeEvents,
  venueTable,
  venuesSection,
  windowStats,
  type SnapshotEvent,
} from "@/lib/export/orderflowSnapshot";
import { aggregateDerivatives } from "@/lib/engine/derivatives";
import type { VenueDepth } from "@/lib/managers/marketDataManager";
import type { NormalizedLiquidation, NormalizedTrade, Venue } from "@/lib/types/market";

const M = 60_000;
const T0 = Date.UTC(2026, 10, 21, 0, 0, 0); // 00:00 UTC, on the hour

function trade(id: string, timestamp: number, price: number, quantity: number, side: "buy" | "sell", venue: Venue = "binance-futures"): NormalizedTrade {
  return { id, venue, symbol: "BTCUSDT", timestamp, localTimestamp: timestamp, price, quantity, quoteVolume: price * quantity, side, marketType: "perpetual" };
}

function liquidation(id: string, timestamp: number, price: number, quantity: number, side: "long" | "short", venue: Venue = "binance-futures"): NormalizedLiquidation {
  return { id, venue, symbol: "BTCUSDT", timestamp, localTimestamp: timestamp, price, quantity, quoteVolume: price * quantity, side };
}

/** 70 live minutes from T0: one print a minute (buy 2 on even minutes, sell 1 on odd), price 60 000 + minute. */
function seventyMinutes(bigPrintUsd = 1e12): MinuteFlow {
  const flow = new MinuteFlow(10, bigPrintUsd);
  for (let m = 0; m < 70; m++) {
    const t = T0 + m * M;
    flow.markCovered(t + 1_000);
    flow.addTrade(trade(`t${m}`, t + 5_000, 60_000 + m, m % 2 ? 1 : 2, m % 2 ? "sell" : "buy"));
    flow.setOpenInterest(t + 30_000, 1_000_000 + m * 1_000);
  }
  return flow;
}

const NOW = T0 + 69 * M + 30_000; // 01:09:30 UTC; minute 69 is still open
const OPTS = { currentOiUSD: 1_069_000, valueAreaPct: 0.7 };

describe("isoWithOffset", () => {
  test("writes ICT with a +07:00 offset, seconds precision", () => {
    expect(isoWithOffset(Date.UTC(2026, 10, 21, 0, 40, 0))).toBe("2026-11-21T07:40:00+07:00");
    expect(isoWithOffset(Date.UTC(2026, 10, 20, 23, 5, 9, 999))).toBe("2026-11-21T06:05:09+07:00");
  });
});

describe("windowStats", () => {
  const w1h = windowStats(seventyMinutes(), NOW, 60 * M, 5 * M, OPTS);

  test("buy + sell = volume and delta = buy − sell", () => {
    expect(w1h.volumeBase).toBeCloseTo(90); // minutes 10–69: 30 buys of 2, 30 sells of 1
    expect(w1h.buyVolumeBase).toBe(60);
    expect(w1h.sellVolumeBase).toBe(30);
    expect(w1h.buyVolumeBase! + w1h.sellVolumeBase!).toBeCloseTo(w1h.volumeBase!, 6);
    expect(w1h.deltaBase).toBe(w1h.buyVolumeBase! - w1h.sellVolumeBase!);
    expect(w1h.buyPct).toBeCloseTo(66.67, 2);
    expect(w1h.deltaUSD).toBeGreaterThan(0);
  });

  test("the last hour is complete; longer windows report the minutes they have", () => {
    expect(w1h).toMatchObject({ complete: true, coverageMin: 60 });
    const w4h = windowStats(seventyMinutes(), NOW, 4 * 60 * M, 15 * M, OPTS);
    expect(w4h).toMatchObject({ complete: false, coverageMin: 70 });
  });

  test("OHLC, VWAP and the profile come from the window's prints", () => {
    expect(w1h.ohlc).toEqual({ o: 60_010, h: 60_069, l: 60_010, c: 60_069 });
    expect(w1h.vwap).toBeGreaterThan(60_010);
    expect(w1h.vwap).toBeLessThan(60_069);
    expect(w1h.profile.valueAreaPct).toBe(70);
    expect(w1h.profile.val!).toBeLessThanOrEqual(w1h.profile.poc!);
    expect(w1h.profile.poc!).toBeLessThanOrEqual(w1h.profile.vah!);
  });

  test("series: closed 5m bars inside the window, oldest first, CVD from the window start", () => {
    const s = w1h.series;
    expect(s.map((b) => (b.tMs - T0) / M)).toEqual([10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]); // 01:05 is still open
    expect(s.map((b) => b.deltaBase)).toEqual([4, 1, 4, 1, 4, 1, 4, 1, 4, 1, 4]);
    expect(s.map((b) => b.cvdBase)).toEqual([4, 5, 9, 10, 14, 15, 19, 20, 24, 25, 29]);
    expect(s[0]).toMatchObject({ close: 60_014, oiUSD: 1_014_000, liqLongUSD: 0, liqShortUSD: 0 });
    // The open bar's delta (minutes 65–69: +1) is in the window total but not in the series.
    expect(w1h.deltaBase).toBe(30);
  });

  test("series lists only fully recorded bars; their minutes still count toward CVD", () => {
    const flow = new MinuteFlow(10, 1e12);
    for (let m = 12; m < 30; m++) {
      // recorded from minute 12: the 00:10 bar is partial
      flow.markCovered(T0 + m * M + 1_000);
      flow.addTrade(trade(`p${m}`, T0 + m * M + 5_000, 60_000, 1, "buy"));
    }
    const w = windowStats(flow, T0 + 29 * M + 30_000, 60 * M, 5 * M, OPTS);
    expect(w.series.map((b) => (b.tMs - T0) / M)).toEqual([15, 20]);
    expect(w.series.map((b) => b.cvdBase)).toEqual([8, 13]); // minutes 12–14 (3) + 15–19 (5), then + 20–24
    expect(w.deltaBase).toBe(18);
  });

  test("open interest change over the window", () => {
    expect(w1h.oi.startUSD).toBe(1_010_000);
    expect(w1h.oi.endUSD).toBe(1_069_000);
    expect(w1h.oi.changePct).toBeCloseTo(((1_069_000 - 1_010_000) / 1_010_000) * 100, 3);
  });

  test("trades per second over the covered time", () => {
    expect(w1h.tradesPerSec).toBeCloseTo(60 / (59 * 60 + 30), 3);
    expect(w1h.realizedVolAnnPct).not.toBeNull();
  });

  test("a repeated print is counted once; a late print lands in its own minute", () => {
    const flow = seventyMinutes();
    expect(flow.addTrade(trade("t20", T0 + 20 * M + 5_000, 60_020, 2, "buy"))).toBe(false);
    expect(flow.addTrade(trade("late", T0 + 20 * M + 59_000, 60_020, 0.5, "sell"))).toBe(true);
    const w = windowStats(flow, NOW, 60 * M, 5 * M, OPTS);
    expect(w.volumeBase).toBeCloseTo(90.5);
    expect(w.series.find((b) => b.tMs === T0 + 20 * M)!.deltaBase).toBe(3.5);
  });

  test("minutes the feed was not live are left out", () => {
    const flow = seventyMinutes();
    flow.addTrade(trade("gap", T0 + 70 * M + 5_000, 60_070, 7, "buy")); // minute 70 never marked covered
    const w = windowStats(flow, T0 + 70 * M + 30_000, 60 * M, 5 * M, OPTS);
    expect(w.coverageMin).toBe(59); // minutes 11–69
    expect(w.complete).toBe(false);
    expect(w.buyVolumeBase).toBe(58); // buys of 2 on minutes 12, 14 … 68; the 7 BTC in minute 70 is left out
  });

  test("an empty window has nulls, not zeros", () => {
    const w = windowStats(new MinuteFlow(10, 1e12), NOW, 60 * M, 5 * M, { currentOiUSD: null, valueAreaPct: 0.7 });
    expect(w).toMatchObject({ complete: false, coverageMin: 0, volumeBase: null, deltaBase: null, vwap: null, tradesPerSec: null, series: [] });
    expect(w.ohlc).toEqual({ o: null, h: null, l: null, c: null });
    expect(w.profile).toEqual({ poc: null, vah: null, val: null, valueAreaPct: 70 });
  });

  test("liquidations, the largest one, and minute clusters", () => {
    const flow = seventyMinutes();
    flow.addLiquidation(liquidation("l1", T0 + 30 * M + 1_000, 60_030, 5, "long")); // $300K
    flow.addLiquidation(liquidation("l2", T0 + 30 * M + 2_000, 60_030, 250_000 / 60_030, "long"));
    flow.addLiquidation(liquidation("l3", T0 + 31 * M + 1_000, 60_031, 50_000 / 60_031, "short", "bybit-futures"));
    const w = windowStats(flow, NOW, 60 * M, 5 * M, OPTS);
    expect(w.liquidations.longUSD).toBeCloseTo(550_150, 0);
    expect(w.liquidations.shortUSD).toBeCloseTo(50_000, 0);
    expect(w.liquidations).toMatchObject({ longCount: 2, shortCount: 1 });
    expect(w.liquidations.largest).toMatchObject({ side: "long", price: 60_030, venue: "binance", tMs: T0 + 30 * M + 1_000 });
    expect(w.series.find((b) => b.tMs === T0 + 30 * M)!.liqLongUSD).toBeCloseTo(550_150, 0);

    const clusters = liquidationClusters(flow, NOW, 500_000);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ type: "liquidationCluster", side: "long", venue: "binance", tMs: T0 + 30 * M });
  });

  test("big prints at or above the threshold", () => {
    const flow = seventyMinutes(200_000);
    flow.addTrade(trade("block", T0 + 40 * M + 9_000, 60_040, 5, "sell"));
    const w = windowStats(flow, NOW, 60 * M, 5 * M, OPTS);
    expect(w.bigPrints).toMatchObject({ count: 1, buyUSD: 0, thresholdUSD: 200_000 });
    expect(w.bigPrints.sellUSD).toBeCloseTo(300_200, 0);
  });
});

describe("bookSection", () => {
  // Deribit quotes in USD, ~0.17% below the USDT venues: depth is measured
  // around each venue's own mid, and walls on the consensus price scale.
  const books: VenueDepth[] = [
    {
      venue: "binance-futures",
      mid: 100_000,
      bids: [[99_993, 5], [99_953, 2], [99_803, 40]],
      asks: [[100_007, 3], [100_047, 1], [100_503, 2], [100_603, 40]],
    },
    { venue: "bybit-futures", mid: 100_000, bids: [[99_996, 4], [99_804, 30]], asks: [[100_008, 2]] },
    { venue: "deribit", mid: 99_830, bids: [[99_823, 1]], asks: [[99_837, 3]] },
  ];
  const book = bookSection(books, 10);

  test("the consensus mid is the venues' median mid", () => {
    expect(consensusMid(books)).toBe(100_000);
  });

  test("depth within ±10 / ±25 bp of each venue's own mid", () => {
    expect(book.depth.bp10).toEqual({ bidBase: 12, askBase: 9, bidAskRatio: 1.3333 });
    expect(book.depth.bp25).toEqual({ bidBase: 82, askBase: 9, bidAskRatio: 9.1111 });
    expect(book.imbalance).toBeCloseTo((12 - 9) / 21, 4);
    expect(book.imbalanceBand).toBe("±10bp");
  });

  test("walls stand out from the side's average and name the venue that holds most of them", () => {
    expect(book.walls).toEqual([
      { side: "bid", price: 99_800, sizeBase: 70, venue: "binance" },
      { side: "ask", price: 100_600, sizeBase: 40, venue: "binance" },
    ]);
  });

  test("no books: nulls", () => {
    const empty = bookSection([], 10);
    expect(empty.imbalance).toBeNull();
    expect(empty.depth.bp10).toEqual({ bidBase: null, askBase: null, bidAskRatio: null });
    expect(empty.walls).toEqual([]);
  });
});

describe("venues", () => {
  const now = T0;
  const configured: Venue[] = ["binance-futures", "bybit-futures", "deribit"];

  test("live and stale by the last message (stale after 30 s)", () => {
    const last = new Map<Venue, number>([["binance-futures", now - 1_000], ["bybit-futures", now - 31_000]]);
    expect(venuesSection(configured, last, now)).toEqual({
      configured: ["binance", "bybit", "deribit"],
      live: ["binance"],
      stale: [{ venue: "bybit", lastMsgAgoMs: 31_000 }, { venue: "deribit", lastMsgAgoMs: null }],
    });
  });

  test("table: price vs the median venue, 1 h volume share, lead / lag wording", () => {
    const buckets = {
      "binance-futures": [{ time: now - 1_000, close: 100_000, buy: 1, sell: 0, trades: 1 }],
      "bybit-futures": [{ time: now - 1_000, close: 100_010, buy: 0, sell: 1, trades: 1 }],
    };
    const rows = venueTable(configured, buckets, new Map<Venue, number>([["binance-futures", 30], ["bybit-futures", 10]]), now);
    expect(rows).toEqual([
      { venue: "binance", last: 100_000, vsMidBp: -1, volShare1hPct: 75, leadLagMs: null, status: null },
      { venue: "bybit", last: 100_010, vsMidBp: 0, volShare1hPct: 25, leadLagMs: null, status: null },
      { venue: "deribit", last: null, vsMidBp: null, volShare1hPct: 0, leadLagMs: null, status: null },
    ]);
    expect([leadStatus(0), leadStatus(250), leadStatus(-500)]).toEqual(["in sync", "leads 250 ms", "lags 500 ms"]);
  });
});

describe("derivativesSection", () => {
  test("OI in USD per venue, funding in percent with its interval, OI-weighted 8h average", () => {
    const d = aggregateDerivatives(
      [
        { venue: "binance-futures", timestamp: T0, openInterest: 100, markPrice: 100_000, indexPrice: 100_020, fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingTime: T0 + 3_600_000 },
        { venue: "hyperliquid", timestamp: T0, openInterest: 50, markPrice: 100_010, indexPrice: 100_020, fundingRate: 0.0000125, fundingIntervalHours: 1 },
      ],
      "binance-futures",
      100_000
    );
    const out = derivativesSection(d, 100_000);
    expect(out.oiTotalUSD).toBe(100 * 100_000 + 50 * 100_010);
    expect(out.oiByVenue).toEqual([{ venue: "binance", oiUSD: 10_000_000 }, { venue: "hyperliquid", oiUSD: 5_000_500 }]);
    expect(out.fundingByVenue).toEqual([
      { venue: "binance", ratePct: 0.01, intervalH: 8, nextFundingMs: T0 + 3_600_000 },
      { venue: "hyperliquid", ratePct: 0.00125, intervalH: 1, nextFundingMs: null },
    ]);
    // 8h-equivalent: binance 0.0001, hyperliquid 0.0001; weighted by OI → 0.0001 = 0.01%.
    expect(out.funding8hAvgPct).toBeCloseTo(0.01, 6);
    expect(out.fundingMethod).toBe("oi-weighted");
    expect(out.basisBp).toBeCloseTo(d!.basisBps!, 2);
  });
});

describe("mergeEvents", () => {
  test("last 4 hours, newest first, at most 50", () => {
    const now = T0 + 10 * 3_600_000;
    const event = (tMs: number): SnapshotEvent => ({ type: "bigPrint", side: "buy", price: 1, sizeBase: 1, usd: 1, venue: "binance", tMs, note: "" });
    const many = Array.from({ length: 60 }, (_, i) => event(now - i * 60_000));
    const merged = mergeEvents([[event(now - 5 * 3_600_000)], many], now);
    expect(merged).toHaveLength(50);
    expect(merged[0].tMs).toBe(now);
    expect(merged.every((e, i) => i === 0 || e.tMs <= merged[i - 1].tMs)).toBe(true);
  });
});

// ─── Schema: every key is always present ─────────────────────────
const WINDOW_TEMPLATE = {
  complete: true,
  coverageMin: 60,
  ohlc: { o: 0, h: 0, l: 0, c: 0 },
  volumeBase: 0,
  volumeUSD: 0,
  buyVolumeBase: 0,
  sellVolumeBase: 0,
  buyPct: 0,
  deltaBase: 0,
  deltaUSD: 0,
  vwap: 0,
  profile: { poc: 0, vah: 0, val: 0, valueAreaPct: 70 },
  oi: { startUSD: null, endUSD: null, changePct: null },
  liquidations: {
    longUSD: 0, shortUSD: 0, longCount: 0, shortCount: 0,
    largest: { side: "long", usd: 0, price: 0, venue: "", tMs: 0 },
  },
  bigPrints: { count: 0, buyUSD: 0, sellUSD: 0, thresholdUSD: 0 },
  realizedVolAnnPct: 0,
  tradesPerSec: 0,
  series: [{ tMs: 0, close: 0, deltaBase: 0, cvdBase: 0, oiUSD: null, liqLongUSD: 0, liqShortUSD: 0 }],
};

const SPEC_TEMPLATE = {
  schema: "orderflow-snapshot/v1",
  symbol: "BTCUSDT",
  scope: "all-perps",
  generatedAt: "",
  generatedAtMs: 0,
  sessionStartMs: 0,
  venues: { configured: [""], live: [""], stale: [{ venue: "", lastMsgAgoMs: 0 }] },
  price: { last: 0, mid: 0, markAvg: null, indexAvg: null },
  windows: { "1h": WINDOW_TEMPLATE, "4h": WINDOW_TEMPLATE, "24h": WINDOW_TEMPLATE },
  derivatives: {
    oiTotalUSD: 0,
    oiByVenue: [{ venue: "", oiUSD: 0 }],
    funding8hAvgPct: 0,
    fundingMethod: "oi-weighted",
    fundingByVenue: [{ venue: "", ratePct: 0, intervalH: 8, nextFundingMs: 0 }],
    basisBp: 0,
  },
  levels: {
    session: { vwap: 0, poc: 0, vah: 0, val: 0 },
    prevDay: { vwap: null, poc: null, vah: null, val: null },
    nakedPocs: [{ price: 0, date: "YYYY-MM-DD" }],
  },
  book: {
    imbalance: 0,
    imbalanceBand: "±10bp",
    depth: { bp10: { bidBase: 0, askBase: 0, bidAskRatio: 0 }, bp25: { bidBase: 0, askBase: 0, bidAskRatio: 0 } },
    walls: [{ side: "bid", price: 0, sizeBase: 0, venue: "consolidated" }],
  },
  venueTable: [{ venue: "", last: 0, vsMidBp: 0, volShare1hPct: 0, leadLagMs: 0, status: "in sync" }],
  events: [{ type: "iceberg", side: "bid", price: 0, sizeBase: null, usd: null, venue: null, tMs: 0, note: "" }],
  health: { feedLagMs: 0, notes: [] },
};

/** Keys missing from `actual` or not in the template, as dotted paths. */
function keyDiff(template: unknown, actual: unknown, path = ""): string[] {
  if (template === null || typeof template !== "object" || actual === null || typeof actual !== "object") return [];
  if (Array.isArray(template)) {
    if (!Array.isArray(actual)) return [`${path} is not an array`];
    return template.length && actual.length ? actual.flatMap((item, i) => keyDiff(template[0], item, `${path}[${i}]`)) : [];
  }
  const t = template as Record<string, unknown>;
  const a = actual as Record<string, unknown>;
  const out: string[] = [];
  for (const key of Object.keys(t)) {
    if (!(key in a)) out.push(`missing ${path}.${key}`);
    else out.push(...keyDiff(t[key], a[key], `${path}.${key}`));
  }
  for (const key of Object.keys(a)) if (!(key in t)) out.push(`extra ${path}.${key}`);
  return out;
}

describe("buildSnapshot", () => {
  function fullInput() {
    const flow = seventyMinutes(100_000);
    flow.addLiquidation(liquidation("l1", T0 + 30 * M + 1_000, 60_030, 10, "long"));
    const derivatives = aggregateDerivatives(
      [{ venue: "binance-futures", timestamp: T0, openInterest: 100, markPrice: 60_070, indexPrice: 60_080, fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingTime: T0 + 7_200_000 }],
      "binance-futures",
      60_069
    );
    return {
      now: NOW,
      symbol: "BTCUSDT",
      sessionStartMs: T0,
      configured: ["binance-futures", "bybit-futures"] as Venue[],
      lastMessage: new Map<Venue, number>([["binance-futures", NOW - 500]]),
      lastPrice: 60_069,
      flow,
      derivatives,
      session: { vwap: 60_040, poc: 60_040, vah: 60_060, val: 60_020 },
      prevDay: { vwap: 59_000, poc: 59_010, vah: 59_200, val: 58_800 },
      nakedPocs: [{ price: 61_000, date: "2026-11-18" }],
      depth: [
        { venue: "binance-futures" as Venue, mid: 60_069, bids: [[60_060, 1], [60_000, 30], [59_990, 1], [59_950, 1]] as [number, number][], asks: [[60_080, 2], [60_100, 1], [60_200, 25], [60_300, 1]] as [number, number][] },
      ],
      venueBuckets: { "binance-futures": [{ time: NOW - 1_000, close: 60_069, buy: 1, sell: 0, trades: 1 }] },
      events: [{ type: "iceberg" as const, side: "bid", price: 60_000, sizeBase: 12, usd: 720_000, venue: "binance", tMs: NOW - 60_000, note: "Iceberg" }],
      feedLagMs: 450.4,
      notes: ["note"],
      valueAreaPct: 0.7,
    };
  }

  test("every key of the spec is present, and nothing else", () => {
    const snapshot = buildSnapshot(fullInput());
    expect(keyDiff(SPEC_TEMPLATE, snapshot)).toEqual([]);
  });

  test("header fields", () => {
    const snapshot = buildSnapshot(fullInput());
    expect(snapshot).toMatchObject({
      schema: "orderflow-snapshot/v1",
      symbol: "BTCUSDT",
      scope: "all-perps",
      generatedAt: "2026-11-21T08:09:30+07:00",
      generatedAtMs: NOW,
      sessionStartMs: T0,
      price: { last: 60_069, mid: 60_069, markAvg: 60_070, indexAvg: 60_080 },
      health: { feedLagMs: 450, notes: ["note"] },
    });
    expect(snapshot.venues.stale).toEqual([{ venue: "bybit", lastMsgAgoMs: null }]);
    expect(Object.keys(snapshot.windows)).toEqual(["1h", "4h", "24h"]);
    expect(snapshot.windows["24h"].series.every((b) => (b.tMs - T0) % 3_600_000 === 0)).toBe(true);
  });

  test("missing inputs become null, never a guess", () => {
    const snapshot = buildSnapshot({ ...fullInput(), derivatives: null, prevDay: null, depth: [], lastPrice: null, feedLagMs: null });
    expect(snapshot.price).toEqual({ last: null, mid: null, markAvg: null, indexAvg: null });
    expect(snapshot.levels.prevDay).toEqual({ vwap: null, poc: null, vah: null, val: null });
    expect(snapshot.derivatives).toMatchObject({ oiTotalUSD: null, oiByVenue: [], funding8hAvgPct: null, fundingByVenue: [], basisBp: null });
    expect(snapshot.book.imbalance).toBeNull();
    expect(snapshot.health.feedLagMs).toBeNull();
    expect(keyDiff(SPEC_TEMPLATE, snapshot)).toEqual([]);
  });

  test("stays far below 200 KB", () => {
    expect(JSON.stringify(buildSnapshot(fullInput())).length).toBeLessThan(200 * 1024);
  });
});
