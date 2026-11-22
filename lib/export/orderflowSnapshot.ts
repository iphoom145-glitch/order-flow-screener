// ============================================================
// ORDERFLOW SNAPSHOT — schema orderflow-snapshot/v1
//
// The JSON file a scheduled task (the "BTC Market Brief") reads instead
// of a localhost API. This module is pure: rolling one-minute buckets of
// executed flow, liquidations and open interest for the last 24 h, and the
// functions that turn them, the consolidated book and the session's live
// state into the snapshot. Wiring lives in orderflowExporter.ts; the file
// is written by app/api/orderflow-export.
//
// Units: prices in USD(T); *Base in the base asset (BTC); *USD in USD;
// *Pct in percent (0.01 = 0.01%); *Bp in basis points; *Ms epoch ms UTC.
// Every key is always present: a value that is not known is null, never
// a guess.
// ============================================================

import type { DerivativesAggregate, NormalizedLiquidation, NormalizedTrade, Venue } from "@/lib/types/market";
import type { VenueDepth } from "@/lib/managers/marketDataManager";
import type { MicroEvent } from "@/lib/engine/microstructure";
import { valueArea } from "@/lib/engine/priorSessions";
import { venueSummary, type VenueBucket } from "@/lib/engine/venues";

export const SNAPSHOT_SCHEMA = "orderflow-snapshot/v1";
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
/** A venue that has sent nothing for longer than this is listed as stale. */
export const STALE_AFTER_MS = 30_000;
/** Events cover this much history, newest first, at most MAX_EVENTS. */
export const EVENT_LOOKBACK_MS = 4 * HOUR_MS;
export const MAX_EVENTS = 50;
/** Timestamps in the file are written in ICT (UTC+07:00). */
export const ICT_OFFSET_MIN = 7 * 60;
/** The book's imbalance is measured within ±10 bp of the mid. */
export const IMBALANCE_BAND = 0.001;
/** Walls are looked for within ±1% of the mid. */
export const WALL_BAND = 0.01;
/** A wall is a price bucket holding at least this many × the side's average bucket. */
const WALL_MULTIPLE = 3;
const MAX_WALLS_PER_SIDE = 3;
/** A wall is credited to one venue when that venue holds at least this share of it. */
const WALL_VENUE_SHARE = 0.5;
const MINUTES_PER_YEAR = 365 * 24 * 60;
/** Minute buckets older than this are dropped (the longest window plus slack). */
const RETAIN_MS = 25 * HOUR_MS;
/** Trade ids remembered to drop a feed's repeat of prints already counted. */
const MAX_SEEN_TRADE_IDS = 50_000;

export type WindowKey = "1h" | "4h" | "24h";

export const WINDOWS: readonly { key: WindowKey; durationMs: number; bucketMs: number }[] = [
  { key: "1h", durationMs: HOUR_MS, bucketMs: 5 * MINUTE_MS },
  { key: "4h", durationMs: 4 * HOUR_MS, bucketMs: 15 * MINUTE_MS },
  { key: "24h", durationMs: 24 * HOUR_MS, bucketMs: HOUR_MS },
];

// ----------------------------------------------------------
// Output types
// ----------------------------------------------------------
export interface SeriesBar {
  tMs: number; // bucket open
  close: number | null;
  deltaBase: number | null;
  cvdBase: number | null; // cumulative delta from the start of the window to this bar's close
  oiUSD: number | null;
  liqLongUSD: number | null;
  liqShortUSD: number | null;
}

export interface LargestLiquidation {
  side: "long" | "short";
  usd: number;
  price: number;
  venue: string;
  tMs: number;
}

export interface WindowStats {
  complete: boolean;
  coverageMin: number;
  ohlc: { o: number | null; h: number | null; l: number | null; c: number | null };
  volumeBase: number | null;
  volumeUSD: number | null;
  buyVolumeBase: number | null;
  sellVolumeBase: number | null;
  buyPct: number | null;
  deltaBase: number | null;
  deltaUSD: number | null;
  vwap: number | null;
  profile: { poc: number | null; vah: number | null; val: number | null; valueAreaPct: number };
  oi: { startUSD: number | null; endUSD: number | null; changePct: number | null };
  liquidations: {
    longUSD: number | null;
    shortUSD: number | null;
    longCount: number | null;
    shortCount: number | null;
    largest: LargestLiquidation | null;
  };
  bigPrints: { count: number | null; buyUSD: number | null; sellUSD: number | null; thresholdUSD: number };
  realizedVolAnnPct: number | null;
  tradesPerSec: number | null;
  series: SeriesBar[];
}

export type EventType = "iceberg" | "absorption" | "stackedImbalance" | "bigPrint" | "liquidationCluster" | "alert";

/**
 * `side`: iceberg / absorption — the resting side that held ("bid" | "ask");
 * stackedImbalance / bigPrint / alert — the aggressor ("buy" | "sell");
 * liquidationCluster — the positions liquidated ("long" | "short").
 */
export interface SnapshotEvent {
  type: EventType;
  side: string | null;
  price: number | null;
  sizeBase: number | null;
  usd: number | null;
  venue: string | null;
  tMs: number;
  note: string;
}

export interface Wall {
  side: "bid" | "ask";
  price: number;
  sizeBase: number;
  venue: string;
}

export interface DepthBand {
  bidBase: number | null;
  askBase: number | null;
  bidAskRatio: number | null;
}

export interface BookSection {
  imbalance: number | null;
  imbalanceBand: string;
  depth: { bp10: DepthBand; bp25: DepthBand };
  walls: Wall[];
}

export interface VenueRow {
  venue: string;
  last: number | null;
  vsMidBp: number | null; // last price vs the median venue's (as the dashboard's Venues panel)
  volShare1hPct: number | null;
  leadLagMs: number | null; // positive: this venue moves first
  status: string | null; // "in sync" | "leads 250 ms" | "lags 500 ms"
}

export interface LevelSet {
  vwap: number | null;
  poc: number | null;
  vah: number | null;
  val: number | null;
}

export interface OrderflowSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  symbol: string;
  scope: "all-perps";
  generatedAt: string;
  generatedAtMs: number;
  sessionStartMs: number | null;
  venues: {
    configured: string[];
    live: string[];
    stale: { venue: string; lastMsgAgoMs: number | null }[];
  };
  price: { last: number | null; mid: number | null; markAvg: number | null; indexAvg: number | null };
  windows: Record<WindowKey, WindowStats>;
  derivatives: {
    oiTotalUSD: number | null;
    oiByVenue: { venue: string; oiUSD: number | null }[];
    funding8hAvgPct: number | null;
    fundingMethod: "oi-weighted" | "simple";
    fundingByVenue: { venue: string; ratePct: number | null; intervalH: number | null; nextFundingMs: number | null }[];
    basisBp: number | null;
  };
  levels: {
    session: LevelSet;
    prevDay: LevelSet;
    nakedPocs: { price: number; date: string }[];
  };
  book: BookSection;
  venueTable: VenueRow[];
  events: SnapshotEvent[];
  health: { feedLagMs: number | null; notes: string[] };
}

// ----------------------------------------------------------
// Formatting helpers
// ----------------------------------------------------------
/** Round to `digits` decimals; null and non-finite values stay null. */
export function round(value: number | null | undefined, digits: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO 8601 with a fixed offset, seconds precision: 2026-11-21T07:40:00+07:00. */
export function isoWithOffset(ms: number, offsetMin = ICT_OFFSET_MIN): string {
  const local = new Date(ms + offsetMin * MINUTE_MS).toISOString().slice(0, 19);
  const abs = Math.abs(offsetMin);
  return `${local}${offsetMin >= 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** UTC calendar date, YYYY-MM-DD. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "binance-futures" → "binance"; venues without a suffix keep their name. */
export function venueName(venue: Venue): string {
  return venue.replace(/-(futures|spot)$/, "");
}

/** The Venues panel's lead / lag wording. */
export function leadStatus(leadMs: number | null): string | null {
  if (leadMs === null) return null;
  if (leadMs === 0) return "in sync";
  return leadMs > 0 ? `leads ${leadMs} ms` : `lags ${-leadMs} ms`;
}

// ----------------------------------------------------------
// One-minute buckets
// ----------------------------------------------------------
export interface MinuteBucket {
  start: number;
  /** The feed was live during this minute (set by the exporter's clock, not by prints). */
  covered: boolean;
  open: number | null;
  openTime: number;
  high: number;
  low: number;
  close: number | null;
  closeTime: number;
  volume: number;
  buy: number;
  sell: number;
  quote: number;
  buyQuote: number;
  sellQuote: number;
  trades: number;
  levels: Map<number, number>; // price / tick (rounded) → base volume
  venueVolume: Map<Venue, number>;
  liqLongUSD: number;
  liqShortUSD: number;
  liqLongCount: number;
  liqShortCount: number;
  liqQty: number;
  liqVenueUSD: Map<Venue, number>;
  largestLiq: NormalizedLiquidation | null;
  bigCount: number;
  bigBuyUSD: number;
  bigSellUSD: number;
  /** Open interest value at the latest sample taken in this minute. */
  oiUSD: number | null;
}

function emptyBucket(start: number): MinuteBucket {
  return {
    start,
    covered: false,
    open: null,
    openTime: Infinity,
    high: -Infinity,
    low: Infinity,
    close: null,
    closeTime: -Infinity,
    volume: 0,
    buy: 0,
    sell: 0,
    quote: 0,
    buyQuote: 0,
    sellQuote: 0,
    trades: 0,
    levels: new Map(),
    venueVolume: new Map(),
    liqLongUSD: 0,
    liqShortUSD: 0,
    liqLongCount: 0,
    liqShortCount: 0,
    liqQty: 0,
    liqVenueUSD: new Map(),
    largestLiq: null,
    bigCount: 0,
    bigBuyUSD: 0,
    bigSellUSD: 0,
    oiUSD: null,
  };
}

const usdOf = (x: { quoteVolume: number; price: number; quantity: number }) =>
  x.quoteVolume > 0 ? x.quoteVolume : x.price * x.quantity;

/** Executed flow, liquidations and open interest by exchange-time minute, for the last 25 h. */
export class MinuteFlow {
  private readonly buckets = new Map<number, MinuteBucket>();
  private readonly seenTrades = new Set<string>();
  private newest = 0;
  private firstCovered: number | null = null;

  constructor(
    readonly tick: number,
    readonly bigPrintUsd: number
  ) {}

  /** Start of the first minute the feed was live, or null. */
  get coveredSince(): number | null {
    return this.firstCovered;
  }

  private bucketAt(time: number): MinuteBucket | null {
    const start = Math.floor(time / MINUTE_MS) * MINUTE_MS;
    if (!Number.isFinite(start) || (this.newest && start < this.newest - RETAIN_MS)) return null;
    let bucket = this.buckets.get(start);
    if (!bucket) {
      bucket = emptyBucket(start);
      this.buckets.set(start, bucket);
      if (start > this.newest) this.newest = start;
    }
    return bucket;
  }

  get(start: number): MinuteBucket | undefined {
    return this.buckets.get(start);
  }

  /**
   * Add a print to the minute it traded in (a late print from a slower venue
   * lands in its own minute). Returns false for a repeat of a print already
   * counted (some feeds re-send recent trades when they resubscribe).
   */
  addTrade(trade: NormalizedTrade): boolean {
    if (this.seenTrades.has(trade.id)) return false;
    this.seenTrades.add(trade.id);
    if (this.seenTrades.size > MAX_SEEN_TRADE_IDS) {
      const oldest = this.seenTrades.values();
      for (let i = 0; i < MAX_SEEN_TRADE_IDS / 2; i++) this.seenTrades.delete(oldest.next().value as string);
    }
    const b = this.bucketAt(trade.timestamp);
    if (!b) return false;
    const { price, quantity } = trade;
    const usd = usdOf(trade);
    if (b.open === null || trade.timestamp < b.openTime) {
      b.open = price;
      b.openTime = trade.timestamp;
    }
    if (b.close === null || trade.timestamp >= b.closeTime) {
      b.close = price;
      b.closeTime = trade.timestamp;
    }
    if (price > b.high) b.high = price;
    if (price < b.low) b.low = price;
    b.volume += quantity;
    b.quote += usd;
    b.trades++;
    if (trade.side === "buy") {
      b.buy += quantity;
      b.buyQuote += usd;
    } else {
      b.sell += quantity;
      b.sellQuote += usd;
    }
    const index = Math.round(price / this.tick);
    b.levels.set(index, (b.levels.get(index) ?? 0) + quantity);
    b.venueVolume.set(trade.venue, (b.venueVolume.get(trade.venue) ?? 0) + quantity);
    if (usd >= this.bigPrintUsd) {
      b.bigCount++;
      if (trade.side === "buy") b.bigBuyUSD += usd;
      else b.bigSellUSD += usd;
    }
    return true;
  }

  addLiquidation(liquidation: NormalizedLiquidation): void {
    const b = this.bucketAt(liquidation.timestamp);
    if (!b) return;
    const usd = usdOf(liquidation);
    if (liquidation.side === "long") {
      b.liqLongUSD += usd;
      b.liqLongCount++;
    } else {
      b.liqShortUSD += usd;
      b.liqShortCount++;
    }
    b.liqQty += liquidation.quantity;
    b.liqVenueUSD.set(liquidation.venue, (b.liqVenueUSD.get(liquidation.venue) ?? 0) + usd);
    if (!b.largestLiq || usd > usdOf(b.largestLiq)) b.largestLiq = liquidation;
  }

  /** The feed was live at `now` (called by the exporter's clock while venues are reporting). */
  markCovered(now: number): void {
    const b = this.bucketAt(now);
    if (!b) return;
    b.covered = true;
    if (this.firstCovered === null || b.start < this.firstCovered) this.firstCovered = b.start;
  }

  /** Record the current open interest value; the last sample in a minute stands for its close. */
  setOpenInterest(now: number, usd: number | null): void {
    if (usd === null || !(usd > 0)) return;
    const b = this.bucketAt(now);
    if (b) b.oiUSD = usd;
  }

  prune(now: number): void {
    const cutoff = now - RETAIN_MS;
    for (const start of this.buckets.keys()) if (start < cutoff) this.buckets.delete(start);
  }

  /** Covered minutes whose start lies in [from, to], oldest first. */
  covered(from: number, to: number): MinuteBucket[] {
    const out: MinuteBucket[] = [];
    for (let t = Math.ceil(from / MINUTE_MS) * MINUTE_MS; t <= to; t += MINUTE_MS) {
      const b = this.buckets.get(t);
      if (b?.covered) out.push(b);
    }
    return out;
  }

  /** Base volume by venue over the covered minutes in [from, to]. */
  venueVolumes(from: number, to: number): Map<Venue, number> {
    const out = new Map<Venue, number>();
    for (const b of this.covered(from, to)) {
      for (const [venue, volume] of b.venueVolume) out.set(venue, (out.get(venue) ?? 0) + volume);
    }
    return out;
  }
}

// ----------------------------------------------------------
// Window statistics
// ----------------------------------------------------------
export interface WindowOptions {
  /** Open interest value now (the window's end). */
  currentOiUSD: number | null;
  /** Value-area share, 0.7 = 70%. */
  valueAreaPct: number;
}

/**
 * Statistics for the trailing `durationMs`, from covered minutes only, and
 * closed `bucketMs` bars (aligned to the clock) that lie inside the window.
 */
export function windowStats(
  flow: MinuteFlow,
  now: number,
  durationMs: number,
  bucketMs: number,
  options: WindowOptions
): WindowStats {
  const windowStart = now - durationMs;
  const minutes = flow.covered(windowStart, now);
  const durationMin = Math.round(durationMs / MINUTE_MS);
  const coverageMin = Math.min(durationMin, minutes.length);
  const has = coverageMin > 0;

  let volume = 0, buy = 0, sell = 0, quote = 0, buyQuote = 0, sellQuote = 0, trades = 0;
  let open: number | null = null, close: number | null = null, high = -Infinity, low = Infinity;
  let liqLong = 0, liqShort = 0, liqLongCount = 0, liqShortCount = 0;
  let largest: NormalizedLiquidation | null = null;
  let bigCount = 0, bigBuy = 0, bigSell = 0;
  let coveredSeconds = 0;
  let oiStart: number | null = null, oiLast: number | null = null;
  const profile = new Map<number, number>();
  const returns: number[] = [];
  let previous: MinuteBucket | null = null;

  for (const m of minutes) {
    volume += m.volume;
    buy += m.buy;
    sell += m.sell;
    quote += m.quote;
    buyQuote += m.buyQuote;
    sellQuote += m.sellQuote;
    trades += m.trades;
    if (m.open !== null && m.close !== null) {
      if (open === null) open = m.open;
      close = m.close;
      if (m.high > high) high = m.high;
      if (m.low < low) low = m.low;
      if (previous?.close != null && m.start - previous.start === MINUTE_MS && previous.close > 0) {
        returns.push(Math.log(m.close / previous.close));
      }
      previous = m;
    } else {
      previous = null;
    }
    for (const [index, v] of m.levels) profile.set(index, (profile.get(index) ?? 0) + v);
    liqLong += m.liqLongUSD;
    liqShort += m.liqShortUSD;
    liqLongCount += m.liqLongCount;
    liqShortCount += m.liqShortCount;
    if (m.largestLiq && (!largest || usdOf(m.largestLiq) > usdOf(largest))) largest = m.largestLiq;
    bigCount += m.bigCount;
    bigBuy += m.bigBuyUSD;
    bigSell += m.bigSellUSD;
    coveredSeconds += Math.min(60, Math.max(0, (now - m.start) / 1000));
    if (m.oiUSD !== null) {
      if (oiStart === null) oiStart = m.oiUSD;
      oiLast = m.oiUSD;
    }
  }

  const va = valueArea(profile, options.valueAreaPct);
  const oiEnd = options.currentOiUSD ?? oiLast;
  const buyRounded = round(buy, 6);
  const sellRounded = round(sell, 6);

  let realizedVol: number | null = null;
  if (returns.length >= 2) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
    realizedVol = Math.sqrt(variance) * Math.sqrt(MINUTES_PER_YEAR) * 100;
  }

  return {
    complete: coverageMin >= durationMin,
    coverageMin,
    ohlc: {
      o: round(open, 2),
      h: open === null ? null : round(high, 2),
      l: open === null ? null : round(low, 2),
      c: round(close, 2),
    },
    volumeBase: has ? round(volume, 6) : null,
    volumeUSD: has ? round(quote, 2) : null,
    buyVolumeBase: has ? buyRounded : null,
    sellVolumeBase: has ? sellRounded : null,
    buyPct: has && volume > 0 ? round((buy / volume) * 100, 2) : null,
    deltaBase: has && buyRounded !== null && sellRounded !== null ? round(buyRounded - sellRounded, 6) : null,
    deltaUSD: has ? round(buyQuote - sellQuote, 2) : null,
    vwap: has && volume > 0 ? round(quote / volume, 2) : null,
    profile: {
      poc: va ? round(va.poc * flow.tick, 2) : null,
      vah: va ? round(va.vah * flow.tick, 2) : null,
      val: va ? round(va.val * flow.tick, 2) : null,
      valueAreaPct: Math.round(options.valueAreaPct * 100),
    },
    oi: {
      startUSD: round(oiStart, 2),
      endUSD: round(oiEnd, 2),
      changePct: oiStart !== null && oiEnd !== null && oiStart > 0 ? round(((oiEnd - oiStart) / oiStart) * 100, 4) : null,
    },
    liquidations: {
      longUSD: has ? round(liqLong, 2) : null,
      shortUSD: has ? round(liqShort, 2) : null,
      longCount: has ? liqLongCount : null,
      shortCount: has ? liqShortCount : null,
      largest: largest
        ? {
            side: largest.side,
            usd: round(usdOf(largest), 2) ?? 0,
            price: round(largest.price, 2) ?? 0,
            venue: venueName(largest.venue),
            tMs: largest.timestamp,
          }
        : null,
    },
    bigPrints: {
      count: has ? bigCount : null,
      buyUSD: has ? round(bigBuy, 2) : null,
      sellUSD: has ? round(bigSell, 2) : null,
      thresholdUSD: flow.bigPrintUsd,
    },
    realizedVolAnnPct: round(realizedVol, 2),
    tradesPerSec: coveredSeconds > 0 ? round(trades / coveredSeconds, 3) : null,
    series: seriesBars(minutes, windowStart, now, bucketMs),
  };
}

/**
 * Closed, clock-aligned bars inside the window, oldest first. A bar is listed
 * only when every one of its minutes was recorded (a partly recorded bar, at
 * start-up or around a gap, would understate its flow); CVD accumulates over
 * every recorded minute from the window's start.
 */
function seriesBars(minutes: MinuteBucket[], windowStart: number, now: number, bucketMs: number): SeriesBar[] {
  const bars: SeriesBar[] = [];
  const minutesPerBar = Math.round(bucketMs / MINUTE_MS);
  let i = 0;
  let cvd = 0;
  for (let start = Math.ceil(windowStart / bucketMs) * bucketMs; start + bucketMs <= now; start += bucketMs) {
    const end = start + bucketMs;
    // Minutes before this bar (inside the window) still count toward the cumulative delta.
    while (i < minutes.length && minutes[i].start < start) {
      cvd += minutes[i].buy - minutes[i].sell;
      i++;
    }
    let delta = 0, liqLong = 0, liqShort = 0, count = 0;
    let close: number | null = null, oi: number | null = null;
    while (i < minutes.length && minutes[i].start < end) {
      const m = minutes[i++];
      count++;
      delta += m.buy - m.sell;
      liqLong += m.liqLongUSD;
      liqShort += m.liqShortUSD;
      if (m.close !== null) close = m.close;
      if (m.oiUSD !== null) oi = m.oiUSD;
    }
    cvd += delta;
    if (count < minutesPerBar) continue; // not fully recorded (before the dashboard started, or a gap)
    bars.push({
      tMs: start,
      close: round(close, 2),
      deltaBase: round(delta, 6),
      cvdBase: round(cvd, 6),
      oiUSD: round(oi, 2),
      liqLongUSD: round(liqLong, 2),
      liqShortUSD: round(liqShort, 2),
    });
  }
  return bars;
}

// ----------------------------------------------------------
// Book
// Depth is measured per venue around that venue's own mid and then summed:
// USD-quoted venues (Deribit, Kraken) trade a USD/USDT basis away from the
// USDT venues, so one merged book is crossed and its mid is meaningless.
// ----------------------------------------------------------
/** Median of the venues' own mids: the consensus price. */
export function consensusMid(books: VenueDepth[]): number | null {
  const mids = books.map((b) => b.mid).filter((m) => m > 0).sort((a, b) => a - b);
  if (!mids.length) return null;
  const n = mids.length;
  return n % 2 ? mids[(n - 1) / 2] : (mids[n / 2 - 1] + mids[n / 2]) / 2;
}

/** Resting size within ±`fraction` of each venue's own mid, summed over venues. */
function bandDepth(books: VenueDepth[], fraction: number): DepthBand {
  let bid = 0;
  let ask = 0;
  for (const book of books) {
    const lo = book.mid * (1 - fraction);
    const hi = book.mid * (1 + fraction);
    for (const [price, size] of book.bids) if (price >= lo) bid += size;
    for (const [price, size] of book.asks) if (price <= hi) ask += size;
  }
  return { bidBase: round(bid, 4), askBase: round(ask, 4), bidAskRatio: ask > 0 ? round(bid / ask, 4) : null };
}

/**
 * The biggest tick buckets on one side within ±1% that clearly stand out from
 * the side's average bucket. Each venue's book is moved onto the consensus
 * price scale (by its own mid's distance from the consensus mid) first.
 */
function sideWalls(books: VenueDepth[], side: "bid" | "ask", refMid: number, tick: number): Wall[] {
  const buckets = new Map<number, { size: number; byVenue: Map<Venue, number> }>();
  const lo = refMid * (1 - WALL_BAND);
  const hi = refMid * (1 + WALL_BAND);
  for (const book of books) {
    const scale = refMid / book.mid;
    for (const [price, size] of side === "bid" ? book.bids : book.asks) {
      const p = price * scale;
      if (p < lo || p > hi) continue;
      const index = Math.round(p / tick);
      let bucket = buckets.get(index);
      if (!bucket) buckets.set(index, (bucket = { size: 0, byVenue: new Map() }));
      bucket.size += size;
      bucket.byVenue.set(book.venue, (bucket.byVenue.get(book.venue) ?? 0) + size);
    }
  }
  if (buckets.size < 2) return [];
  let total = 0;
  for (const b of buckets.values()) total += b.size;
  const threshold = (total / buckets.size) * WALL_MULTIPLE;
  return [...buckets.entries()]
    .filter(([, b]) => b.size >= threshold)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, MAX_WALLS_PER_SIDE)
    .map(([index, b]) => {
      const [topVenue, topSize] = [...b.byVenue.entries()].sort((x, y) => y[1] - x[1])[0];
      return {
        side,
        price: round(index * tick, 2) ?? 0,
        sizeBase: round(b.size, 4) ?? 0,
        venue: topSize >= b.size * WALL_VENUE_SHARE ? venueName(topVenue) : "consolidated",
      };
    });
}

/** Imbalance (±10 bp), depth within ±10 / ±25 bp and walls (±1%) across the venues' books. */
export function bookSection(books: VenueDepth[], tick: number): BookSection {
  const empty: DepthBand = { bidBase: null, askBase: null, bidAskRatio: null };
  const refMid = consensusMid(books);
  if (refMid === null) {
    return { imbalance: null, imbalanceBand: "±10bp", depth: { bp10: empty, bp25: empty }, walls: [] };
  }
  const bp10 = bandDepth(books, IMBALANCE_BAND);
  const bid = bp10.bidBase ?? 0;
  const ask = bp10.askBase ?? 0;
  return {
    imbalance: bid + ask > 0 ? round((bid - ask) / (bid + ask), 4) : null,
    imbalanceBand: "±10bp",
    depth: { bp10, bp25: bandDepth(books, 0.0025) },
    walls: [...sideWalls(books, "bid", refMid, tick), ...sideWalls(books, "ask", refMid, tick)],
  };
}

// ----------------------------------------------------------
// Venues
// ----------------------------------------------------------
export function venuesSection(configured: Venue[], lastMessage: ReadonlyMap<Venue, number>, now: number): OrderflowSnapshot["venues"] {
  const live: string[] = [];
  const stale: { venue: string; lastMsgAgoMs: number | null }[] = [];
  for (const venue of configured) {
    const at = lastMessage.get(venue);
    if (at !== undefined && now - at <= STALE_AFTER_MS) live.push(venueName(venue));
    else stale.push({ venue: venueName(venue), lastMsgAgoMs: at === undefined ? null : Math.max(0, now - at) });
  }
  return { configured: configured.map(venueName), live, stale };
}

/** One row per configured venue: price vs the median venue, 1 h volume share and lead / lag. */
export function venueTable(
  configured: Venue[],
  buckets: Partial<Record<Venue, VenueBucket[]>>,
  volume1h: ReadonlyMap<Venue, number>,
  now: number
): VenueRow[] {
  const stats = new Map(venueSummary(buckets, now).stats.map((s) => [s.venue, s]));
  let total = 0;
  for (const venue of configured) total += volume1h.get(venue) ?? 0;
  return configured.map((venue) => {
    const s = stats.get(venue);
    return {
      venue: venueName(venue),
      last: s ? round(s.last, 2) : null,
      vsMidBp: s ? round(s.premiumBps, 2) : null,
      volShare1hPct: total > 0 ? round(((volume1h.get(venue) ?? 0) / total) * 100, 2) : null,
      leadLagMs: s?.leadMs ?? null,
      status: leadStatus(s?.leadMs ?? null),
    };
  });
}

// ----------------------------------------------------------
// Derivatives
// ----------------------------------------------------------
export function derivativesSection(d: DerivativesAggregate | null, lastPrice: number | null): OrderflowSnapshot["derivatives"] {
  const venues = d?.venues ?? [];
  return {
    oiTotalUSD: round(d?.openInterestValue ?? null, 2),
    oiByVenue: venues
      .filter((v) => v.openInterest !== undefined)
      .map((v) => ({ venue: venueName(v.venue), oiUSD: round(v.openInterest! * (v.markPrice ?? lastPrice ?? NaN), 2) })),
    funding8hAvgPct: d?.fundingRate8h == null ? null : round(d.fundingRate8h * 100, 6),
    fundingMethod: "oi-weighted",
    fundingByVenue: venues
      .filter((v) => v.fundingRate !== undefined)
      .map((v) => ({
        venue: venueName(v.venue),
        ratePct: round(v.fundingRate! * 100, 6),
        intervalH: v.fundingIntervalHours ?? 8,
        nextFundingMs: v.nextFundingTime ?? null,
      })),
    basisBp: round(d?.basisBps ?? null, 2),
  };
}

// ----------------------------------------------------------
// Events
// ----------------------------------------------------------
const compactUsd = (usd: number) =>
  usd >= 1e9 ? `$${(usd / 1e9).toFixed(2)}B` : usd >= 1e6 ? `$${(usd / 1e6).toFixed(2)}M` : `$${Math.round(usd / 1e3)}K`;

export function microEventToSnapshot(e: MicroEvent): SnapshotEvent {
  const held = e.side === "bid" ? "bid held against selling" : "offer held against buying";
  return {
    type: e.kind,
    side: e.side,
    price: round(e.price, 2),
    sizeBase: round(e.volume, 4),
    usd: round(e.notional, 2),
    venue: e.venue ? venueName(e.venue) : null,
    tMs: e.time,
    note:
      e.kind === "iceberg"
        ? `Iceberg: ${e.ratio.toFixed(1)}× the displayed size traded and the level refilled`
        : `Absorption: ${held}, ${e.ratio.toFixed(1)}× an average 10 s window`,
  };
}

export function bigPrintEvent(trade: NormalizedTrade): SnapshotEvent {
  const usd = usdOf(trade);
  return {
    type: "bigPrint",
    side: trade.side,
    price: round(trade.price, 2),
    sizeBase: round(trade.quantity, 4),
    usd: round(usd, 2),
    venue: venueName(trade.venue),
    tMs: trade.timestamp,
    note: `Taker ${trade.side} of ${trade.quantity.toFixed(3)} BTC (${compactUsd(usd)}) on ${venueName(trade.venue)}`,
  };
}

export function stackedImbalanceEvent(
  run: { dir: "buy" | "sell"; start: number; end: number },
  candleOpen: number,
  tick: number,
  ratio: number
): SnapshotEvent {
  const levels = Math.round((run.end - run.start) / tick) + 1;
  return {
    type: "stackedImbalance",
    side: run.dir,
    price: round((run.start + run.end) / 2, 2),
    sizeBase: null,
    usd: null,
    venue: null,
    tMs: candleOpen,
    note: `${levels} stacked ${run.dir} imbalances ≥${ratio}× from ${run.start} to ${run.end} in the 1m bar at ${isoWithOffset(candleOpen).slice(11, 16)} ICT`,
  };
}

/** Minutes whose liquidations add up to at least `thresholdUsd`. */
export function liquidationClusters(flow: MinuteFlow, now: number, thresholdUsd: number): SnapshotEvent[] {
  const out: SnapshotEvent[] = [];
  for (let t = Math.floor((now - EVENT_LOOKBACK_MS) / MINUTE_MS) * MINUTE_MS; t <= now; t += MINUTE_MS) {
    const b = flow.get(t);
    if (!b) continue;
    const usd = b.liqLongUSD + b.liqShortUSD;
    if (usd < thresholdUsd || usd <= 0) continue;
    const side = b.liqLongUSD >= b.liqShortUSD ? "long" : "short";
    const venues = [...b.liqVenueUSD.entries()].sort((a, c) => c[1] - a[1]);
    out.push({
      type: "liquidationCluster",
      side,
      price: b.liqQty > 0 ? round(usd / b.liqQty, 2) : null,
      sizeBase: round(b.liqQty, 4),
      usd: round(usd, 2),
      venue: venues.length === 1 ? venueName(venues[0][0]) : null,
      tMs: t,
      note: `${b.liqLongCount + b.liqShortCount} liquidations in 1m (${compactUsd(b.liqLongUSD)} long, ${compactUsd(b.liqShortUSD)} short) on ${venues.map(([v]) => venueName(v)).join(", ")}`,
    });
  }
  return out;
}

/** Newest first, within the look-back, at most MAX_EVENTS. */
export function mergeEvents(lists: SnapshotEvent[][], now: number): SnapshotEvent[] {
  return lists
    .flat()
    .filter((e) => e.tMs >= now - EVENT_LOOKBACK_MS && e.tMs <= now + MINUTE_MS)
    .sort((a, b) => b.tMs - a.tMs)
    .slice(0, MAX_EVENTS);
}

// ----------------------------------------------------------
// Assembly
// ----------------------------------------------------------
export interface SnapshotInput {
  now: number;
  symbol: string;
  sessionStartMs: number | null;
  configured: Venue[];
  lastMessage: ReadonlyMap<Venue, number>;
  lastPrice: number | null;
  flow: MinuteFlow;
  derivatives: DerivativesAggregate | null;
  session: LevelSet;
  prevDay: LevelSet | null;
  nakedPocs: { price: number; date: string }[];
  /** Each venue's book within ±1% of its own mid. */
  depth: VenueDepth[];
  venueBuckets: Partial<Record<Venue, VenueBucket[]>>;
  events: SnapshotEvent[];
  feedLagMs: number | null;
  notes: string[];
  valueAreaPct: number;
}

const levelSet = (l: LevelSet | null): LevelSet => ({
  vwap: round(l?.vwap ?? null, 2),
  poc: round(l?.poc ?? null, 2),
  vah: round(l?.vah ?? null, 2),
  val: round(l?.val ?? null, 2),
});

export function buildSnapshot(input: SnapshotInput): OrderflowSnapshot {
  const { now, flow, derivatives: d } = input;
  const currentOiUSD = d?.openInterestValue ?? null;
  const windows = Object.fromEntries(
    WINDOWS.map((w) => [w.key, windowStats(flow, now, w.durationMs, w.bucketMs, { currentOiUSD, valueAreaPct: input.valueAreaPct })])
  ) as Record<WindowKey, WindowStats>;

  return {
    schema: SNAPSHOT_SCHEMA,
    symbol: input.symbol,
    scope: "all-perps",
    generatedAt: isoWithOffset(now),
    generatedAtMs: now,
    sessionStartMs: input.sessionStartMs,
    venues: venuesSection(input.configured, input.lastMessage, now),
    price: {
      last: round(input.lastPrice, 2),
      mid: round(consensusMid(input.depth), 2),
      markAvg: round(d?.markPrice ?? null, 2),
      indexAvg: round(d?.indexPrice ?? null, 2),
    },
    windows,
    derivatives: derivativesSection(d, input.lastPrice),
    levels: {
      session: levelSet(input.session),
      prevDay: levelSet(input.prevDay),
      nakedPocs: input.nakedPocs.map((n) => ({ price: round(n.price, 2) ?? 0, date: n.date })),
    },
    book: bookSection(input.depth, flow.tick),
    venueTable: venueTable(input.configured, input.venueBuckets, flow.venueVolumes(now - HOUR_MS, now), now),
    events: input.events,
    health: { feedLagMs: input.feedLagMs === null ? null : Math.round(input.feedLagMs), notes: input.notes },
  };
}
