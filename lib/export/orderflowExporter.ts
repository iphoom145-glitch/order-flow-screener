"use client";

// ============================================================
// ORDERFLOW EXPORTER
// A background market session pinned to one symbol across every
// perpetual venue — independent of what the dashboard is showing — that
// posts an orderflow-snapshot/v1 file every minute (see
// orderflowSnapshot.ts for the schema and app/api/orderflow-export for
// the writer). It shares the venues' sockets with the dashboard through
// the adapter pool and keeps running while the tab is hidden.
// ============================================================

import type { StoreApi } from "zustand";
import { createTerminalStore, type TerminalStore } from "@/lib/store/terminalStore";
import { MarketDataManager } from "@/lib/managers/marketDataManager";
import { venuesForSelection } from "@/lib/adapters/capabilities";
import { stackedRuns } from "@/lib/engine/imbalance";
import { DAY_MS, dayLevels, fetchBinanceKlines, nakedPocs, utcDay, type Kline } from "@/lib/engine/priorSessions";
import { useAlertStore } from "@/lib/store/alertStore";
import type { AlertRuleId } from "@/lib/engine/alerts";
import type { FootprintCandle, NormalizedTrade, Venue } from "@/lib/types/market";
import {
  EVENT_LOOKBACK_MS,
  MINUTE_MS,
  MinuteFlow,
  STALE_AFTER_MS,
  WALL_BAND,
  bigPrintEvent,
  buildSnapshot,
  isoWithOffset,
  liquidationClusters,
  mergeEvents,
  microEventToSnapshot,
  stackedImbalanceEvent,
  utcDate,
  type LevelSet,
  type OrderflowSnapshot,
  type SavedFlow,
  type SnapshotEvent,
} from "./orderflowSnapshot";

/** "standby": another writer owns the file; this exporter keeps trying. */
export type DeliverResult = "written" | "standby";

export interface ExporterOptions {
  /** Where snapshots go; by default they are POSTed to `endpoint`. The headless service writes the file itself. */
  deliver?: (snapshot: OrderflowSnapshot, body: string) => Promise<DeliverResult>;
  /** Default BTCUSDT. */
  symbol?: string;
  /** Time between writes, default 60 s. */
  intervalMs?: number;
  /** Default /api/orderflow-export. */
  endpoint?: string;
  /** Price bucket for window profiles and walls, default 10. */
  tick?: number;
  /** Prints at least this large count as big prints in the window stats, default $100K. */
  bigPrintUsd?: number;
  /** Prints at least this large are listed as events, default $500K. */
  bigPrintEventUsd?: number;
  /** Liquidations adding up to this much within one minute are listed as an event, default $500K. */
  liquidationClusterUsd?: number;
  /** The dashboard's own session: while it shows the same market, header values come from it. */
  dashboard?: StoreApi<TerminalStore> | null;
}

/** The dashboard's footprint defaults: 3× imbalance, 3 stacked levels. */
const IMBALANCE_RATIO = 3;
const STACKED_LEVELS = 3;
const VALUE_AREA_PCT = 0.7;
/** Give the venues time to connect before the first file. */
const FIRST_EXPORT_DELAY_MS = 10_000;
const PRIOR_REFRESH_MS = 30 * MINUTE_MS;
const PRIOR_DAYS_BACK = 7;
const MAX_SNAPSHOT_BYTES = 200 * 1024;
/** The dashboard view's values count as current while it has flushed within this long. */
const DASHBOARD_FRESH_MS = 5_000;
/** Dashboard alert rules the exporter does not already detect itself. */
const ALERT_RULES_AS_EVENTS = new Set<AlertRuleId>(["vwapCross", "valueAreaCross", "volumeZ", "cvdDivergence"]);
const LIQUIDATION_NOTE =
  "Liquidations come from binance, bybit, okx, deribit, gate and kraken; bitget, hyperliquid, kucoin and htx publish no liquidation feed.";

/** What a restart needs to carry on: the recorded minutes and the recent events. */
export interface ExporterState {
  version: 1;
  symbol: string;
  savedAt: number;
  flow: SavedFlow;
  events: SnapshotEvent[];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const WRITER_KEY = "orderflow-export-writer";

/** One id per browser tab, kept across reloads, so a reload keeps the tab's write lease. */
function tabWriterId(): string {
  try {
    const saved = sessionStorage.getItem(WRITER_KEY);
    if (saved && /^[A-Za-z0-9-]{8,64}$/.test(saved)) return saved;
  } catch {
    // storage unavailable: fall through to a fresh id
  }
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  try {
    sessionStorage.setItem(WRITER_KEY, id);
  } catch {
    // storage unavailable: the id lasts for this page view
  }
  return id;
}

export class OrderflowExporter {
  readonly store = createTerminalStore();
  readonly manager = new MarketDataManager(this.store);
  readonly symbol: string;
  private readonly intervalMs: number;
  private readonly endpoint: string;
  private readonly tick: number;
  private readonly bigPrintEventUsd: number;
  private readonly liquidationClusterUsd: number;
  private readonly dashboard: StoreApi<TerminalStore> | null;
  private readonly venues: Venue[];
  private readonly flow: MinuteFlow;

  private bigPrints: SnapshotEvent[] = [];
  private stacked: SnapshotEvent[] = [];
  private restoredEvents: SnapshotEvent[] = [];
  /** Set when history from before a restart was loaded. */
  private restored: { minutes: number; savedAt: number } | null = null;
  private seenCandles = new Set<number>();
  private prior: { day: number; klines: Kline[] } | null = null;
  private priorError: string | null = null;
  private priorRequest: AbortController | null = null;
  private secondTimer: ReturnType<typeof setInterval> | null = null;
  private priorTimer: ReturnType<typeof setInterval> | null = null;
  private exportTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void)[] = [];
  private seconds = 0;
  private writing = false;
  private disposed = false;
  private lastWriteError: string | null = null;
  private readonly writerId = tabWriterId();
  private readonly deliver: (snapshot: OrderflowSnapshot, body: string) => Promise<DeliverResult>;
  /** Another dashboard owns the file; this one keeps trying and takes over when it stops. */
  standby = false;
  /** Wall time of the last successful write (for diagnostics). */
  lastWrittenAt: number | null = null;

  constructor(options: ExporterOptions = {}) {
    this.symbol = options.symbol ?? "BTCUSDT";
    this.intervalMs = Math.max(5_000, options.intervalMs ?? 60_000);
    this.endpoint = options.endpoint ?? "/api/orderflow-export";
    this.tick = options.tick ?? 10;
    this.bigPrintEventUsd = options.bigPrintEventUsd ?? 500_000;
    this.liquidationClusterUsd = options.liquidationClusterUsd ?? 500_000;
    this.dashboard = options.dashboard ?? null;
    this.deliver = options.deliver ?? ((snapshot, body) => this.postToRoute(snapshot, body));
    this.venues = venuesForSelection("all-perps", "perpetual", this.symbol);
    this.flow = new MinuteFlow(this.tick, options.bigPrintUsd ?? 100_000);
  }

  start(): void {
    this.manager.subscribe("all-perps", this.symbol, "perpetual", "1m", this.tick, IMBALANCE_RATIO, this.venues);
    this.unsubscribe.push(
      this.manager.addObserver({
        trade: (trade) => this.onTrade(trade),
        liquidation: (liquidation) => this.flow.addLiquidation(liquidation),
      }),
      this.store.subscribe((state, previous) => {
        if (state.candles !== previous.candles) this.onCandles(state.candles);
      })
    );
    this.secondTimer = setInterval(() => this.onSecond(Date.now()), 1000);
    this.priorTimer = setInterval(() => void this.refreshPrior(), PRIOR_REFRESH_MS);
    void this.refreshPrior();
    this.exportTimer = setTimeout(() => this.cycle(), FIRST_EXPORT_DELAY_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.secondTimer) clearInterval(this.secondTimer);
    if (this.priorTimer) clearInterval(this.priorTimer);
    if (this.exportTimer) clearTimeout(this.exportTimer);
    this.priorRequest?.abort();
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.manager.disconnect();
  }

  // ─── Inputs ───────────────────────────────────────────────────
  private onTrade(trade: NormalizedTrade): void {
    if (!this.flow.addTrade(trade)) return;
    const usd = trade.quoteVolume > 0 ? trade.quoteVolume : trade.price * trade.quantity;
    if (usd >= this.bigPrintEventUsd) {
      this.bigPrints.push(bigPrintEvent(trade));
      const cutoff = Date.now() - EVENT_LOOKBACK_MS;
      if (this.bigPrints.length > 500 || this.bigPrints[0].tMs < cutoff) this.bigPrints = this.bigPrints.filter((e) => e.tMs >= cutoff).slice(-500);
    }
  }

  /** Stacked imbalances in each 1m bar, once it closes. */
  private onCandles(candles: FootprintCandle[]): void {
    const tick = this.store.getState().tickSize || this.tick;
    for (const candle of candles) {
      if (!candle.complete || this.seenCandles.has(candle.openTime)) continue;
      this.seenCandles.add(candle.openTime);
      for (const run of stackedRuns(candle, IMBALANCE_RATIO, STACKED_LEVELS)) {
        this.stacked.push(stackedImbalanceEvent(run, candle.openTime, tick, IMBALANCE_RATIO));
      }
    }
    if (this.seenCandles.size > 1_000) this.seenCandles = new Set([...this.seenCandles].slice(-600));
    const cutoff = Date.now() - EVENT_LOOKBACK_MS;
    if (this.stacked.length && this.stacked[0].tMs < cutoff) this.stacked = this.stacked.filter((e) => e.tMs >= cutoff);
  }

  /** Coverage, open-interest samples and housekeeping, once a second. */
  private onSecond(now: number): void {
    const last = this.manager.venueLastMessage();
    if (this.venues.some((venue) => now - (last.get(venue) ?? -Infinity) <= STALE_AFTER_MS)) this.flow.markCovered(now);
    this.flow.setOpenInterest(now, this.store.getState().derivatives?.openInterestValue ?? null);
    if (++this.seconds % 60 === 0) this.flow.prune(now);
  }

  private async refreshPrior(): Promise<void> {
    const now = Date.now();
    const today = utcDay(now);
    this.priorRequest?.abort();
    const request = new AbortController();
    this.priorRequest = request;
    try {
      const klines = await fetchBinanceKlines(this.symbol, "perpetual", today - PRIOR_DAYS_BACK * DAY_MS, Math.min(today + DAY_MS, now), request.signal);
      if (this.disposed || request.signal.aborted) return;
      this.prior = { day: today, klines };
      this.priorError = null;
    } catch (error) {
      if (!request.signal.aborted) this.priorError = errorText(error);
    }
  }

  // ─── Snapshot ─────────────────────────────────────────────────
  /** The dashboard's view when it shows this market and is live; otherwise the background session. */
  private headerSource(now: number): { state: TerminalStore; fromDashboard: boolean } {
    const ui = this.dashboard?.getState();
    if (
      ui &&
      ui.symbol === this.symbol &&
      ui.venue === "all-perps" &&
      ui.marketType === "perpetual" &&
      !ui.replay &&
      ui.session &&
      now - ui.marketClock <= DASHBOARD_FRESH_MS
    ) {
      return { state: ui, fromDashboard: true };
    }
    return { state: this.store.getState(), fromDashboard: false };
  }

  private priorLevels(now: number, sessionHigh: number, sessionLow: number): { previous: LevelSet | null; naked: { price: number; date: string }[] } {
    if (!this.prior) return { previous: null, naked: [] };
    const today = utcDay(now);
    if (this.prior.day !== today) void this.refreshPrior(); // a new UTC day: yesterday's bars are needed
    const days = dayLevels(this.prior.klines, this.tick, VALUE_AREA_PCT, today);
    let high = sessionHigh;
    let low = sessionLow;
    for (const k of this.prior.klines) {
      if (k.openTime < today) continue;
      high = Math.max(high, k.high);
      low = Math.min(low, k.low);
    }
    const previous = days.find((d) => d.day === today - DAY_MS) ?? null;
    return {
      previous: previous ? { vwap: previous.vwap, poc: previous.poc, vah: previous.vah, val: previous.val } : null,
      // Yesterday's POC is reported as prevDay.poc; list only older untested ones.
      naked: nakedPocs(days, high, low)
        .filter((d) => d.day !== previous?.day)
        .map((d) => ({ price: d.poc, date: utcDate(d.day) })),
    };
  }

  private alertEvents(now: number): SnapshotEvent[] {
    return useAlertStore
      .getState()
      .log.filter((a) => a.symbol === this.symbol && !a.replay && ALERT_RULES_AS_EVENTS.has(a.rule) && a.time >= now - EVENT_LOOKBACK_MS)
      .map((a) => ({
        type: "alert" as const,
        side: a.tone === "buy" || a.tone === "sell" ? a.tone : null,
        price: null,
        sizeBase: null,
        usd: null,
        venue: null,
        tMs: a.time,
        note: a.title,
      }));
  }

  // ─── State across restarts ─────────────────────────────────────
  /** Everything needed to continue after a restart (see importState). */
  exportState(now = Date.now()): ExporterState {
    return {
      version: 1,
      symbol: this.symbol,
      savedAt: now,
      flow: this.flow.save(),
      events: mergeEvents(
        [this.store.getState().microEvents.map(microEventToSnapshot), this.bigPrints, this.stacked, this.restoredEvents],
        now
      ),
    };
  }

  /**
   * Load a saved state before start(). A state for another symbol, another
   * version or a different price bucket is ignored. Returns the number of
   * minutes loaded; the minutes while the exporter was stopped stay missing.
   */
  importState(state: unknown, now = Date.now()): number {
    const saved = state as Partial<ExporterState> | null;
    if (!saved || saved.version !== 1 || saved.symbol !== this.symbol || !saved.flow) return 0;
    const minutes = this.flow.restore(saved.flow, now);
    this.restoredEvents = (Array.isArray(saved.events) ? saved.events : []).filter(
      (e) => !!e && typeof e.tMs === "number" && e.tMs >= now - EVENT_LOOKBACK_MS && e.tMs <= now
    );
    if (minutes) this.restored = { minutes, savedAt: typeof saved.savedAt === "number" ? saved.savedAt : now };
    return minutes;
  }

  private notes(fromDashboard: boolean, own: TerminalStore): string[] {
    const notes: string[] = [];
    const since = this.flow.coveredSince;
    notes.push(
      since === null
        ? "No live data recorded yet."
        : `Windows use live data recorded since ${isoWithOffset(since)}; no REST backfill (most venues publish no historical taker buy/sell split).`
    );
    if (this.restored) {
      notes.push(
        `${this.restored.minutes} minutes of history from before a restart were restored (saved ${isoWithOffset(this.restored.savedAt)}); the minutes while the exporter was stopped are missing.`
      );
    }
    const ui = this.dashboard?.getState();
    notes.push(
      fromDashboard
        ? "Session levels, open interest, funding and basis are the dashboard's own values (it is showing this market)."
        : `Session levels, open interest, funding and basis come from the exporter's background session (started ${own.session ? isoWithOffset(own.session.startTime) : "—"})${ui ? `; the dashboard is showing ${ui.symbol} ${ui.venue}${ui.replay ? " (replay)" : ""}` : ""}.`
    );
    notes.push(LIQUIDATION_NOTE);
    notes.push(
      this.priorError
        ? `prevDay and nakedPocs unavailable: ${this.priorError}`
        : this.prior
          ? "prevDay and nakedPocs come from Binance perpetual 5m klines over UTC days, each bar's volume spread across its range (as the dashboard draws them)."
          : "prevDay and nakedPocs: Binance klines are still loading."
    );
    if (typeof document !== "undefined" && document.hidden) {
      notes.push("The dashboard tab is hidden; the browser may delay the export timer.");
    }
    if (this.lastWriteError) notes.push(`The previous write failed: ${this.lastWriteError}`);
    return notes;
  }

  /** Build the snapshot for `now` from the background session and, when it matches, the dashboard. */
  snapshot(now = Date.now()): OrderflowSnapshot {
    const own = this.store.getState();
    const { state: header, fromDashboard } = this.headerSource(now);
    const prior = this.priorLevels(now, own.session?.high ?? -Infinity, own.session?.low ?? Infinity);
    return buildSnapshot({
      now,
      symbol: this.symbol,
      sessionStartMs: header.session?.startTime ?? null,
      configured: this.venues,
      lastMessage: this.manager.venueLastMessage(),
      lastPrice: header.ticker?.price ?? header.session?.last ?? null,
      flow: this.flow,
      derivatives: header.derivatives,
      session: {
        vwap: header.session?.vwap ?? null,
        poc: header.volumeProfile?.poc ?? null,
        vah: header.volumeProfile?.vah ?? null,
        val: header.volumeProfile?.val ?? null,
      },
      prevDay: prior.previous,
      nakedPocs: prior.naked,
      depth: this.manager.bookDepth(WALL_BAND),
      venueBuckets: own.venueBuckets,
      events: mergeEvents(
        [
          own.microEvents.map(microEventToSnapshot),
          this.bigPrints,
          this.stacked,
          this.restoredEvents,
          liquidationClusters(this.flow, now, this.liquidationClusterUsd),
          this.alertEvents(now),
        ],
        now
      ),
      feedLagMs: own.session?.lastTradeLagMs ?? null,
      notes: this.notes(fromDashboard, own),
      valueAreaPct: VALUE_AREA_PCT,
    });
  }

  // ─── Writing ──────────────────────────────────────────────────
  private cycle(): void {
    if (this.disposed) return;
    const started = Date.now();
    void this.exportOnce().finally(() => {
      if (this.disposed) return;
      this.exportTimer = setTimeout(() => this.cycle(), Math.max(1_000, this.intervalMs - (Date.now() - started)));
    });
  }

  /** Build and post one snapshot. Failures are logged and retried on the next round. */
  async exportOnce(): Promise<boolean> {
    if (this.writing) return false;
    this.writing = true;
    try {
      let snapshot = this.snapshot();
      let body = JSON.stringify(snapshot);
      if (body.length > MAX_SNAPSHOT_BYTES) {
        snapshot = {
          ...snapshot,
          events: snapshot.events.slice(0, 10),
          health: { ...snapshot.health, notes: [...snapshot.health.notes, "Events were cut to 10 to keep the file under 200 KB."] },
        };
        body = JSON.stringify(snapshot);
      }
      if ((await this.deliver(snapshot, body)) === "standby") {
        if (!this.standby) console.info("[orderflow-export] another writer owns the file; standing by");
        this.standby = true;
        return false;
      }
      this.standby = false;
      this.lastWriteError = null;
      this.lastWrittenAt = Date.now();
      return true;
    } catch (error) {
      this.lastWriteError = errorText(error);
      console.warn("[orderflow-export] write failed, retrying next round:", this.lastWriteError);
      return false;
    } finally {
      this.writing = false;
    }
  }

  /** The dashboard's default destination: its own API route, which writes the file. */
  private async postToRoute(_snapshot: OrderflowSnapshot, body: string): Promise<DeliverResult> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-orderflow-writer": this.writerId },
      body,
      cache: "no-store",
    });
    if (response.status === 409) return "standby";
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `HTTP ${response.status}`);
    }
    return "written";
  }
}
