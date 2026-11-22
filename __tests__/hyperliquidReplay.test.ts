// ============================================================
// Hyperliquid replays its last trades after every subscription
// The `trades` channel sends the last 30 trades as its first message after
// a subscribe or a reconnect, unmarked. Counting them back-dated old prints
// and, after a reconnect, counted prints a second time.
// ============================================================

import { EventEmitter } from "events";
import { HyperliquidAdapter } from "@/lib/adapters/exchanges";
import { SieblyAdapter, type AckResult } from "@/lib/adapters/siebly";
import type { NormalizedTrade, Venue } from "@/lib/types/market";

type Raw = { coin: string; side: "A" | "B"; px: string; sz: string; time: number; tid: number };
const T = 1_700_000_000_000;
const raw = (tid: number, time = T + tid): Raw => ({ coin: "BTC", side: tid % 2 ? "B" : "A", px: "60000", sz: "0.1", time, tid });
const message = (...trades: Raw[]) => ({ channel: "trades", data: trades });

function adapter() {
  const a = new HyperliquidAdapter("BTCUSDT");
  const trades: NormalizedTrade[] = [];
  a.on("trade", (t: NormalizedTrade) => trades.push(t));
  const internals = a as unknown as {
    handleMessage(m: unknown): void;
    onTopicsSubscribed(topics: unknown[]): void;
    topics(): unknown[];
  };
  return {
    trades,
    feed: (m: unknown) => internals.handleMessage(m),
    subscribed: (topics = internals.topics()) => internals.onTopicsSubscribed(topics),
  };
}

describe("Hyperliquid trade replay", () => {
  it("skips the replay that follows a subscription and keeps the live prints after it", () => {
    const hl = adapter();
    hl.subscribed();
    hl.feed(message(raw(1, T - 20_000), raw(2, T - 10_000), raw(3, T - 1_000))); // replay of recent trades
    hl.feed(message(raw(4)));
    hl.feed(message(raw(5), raw(6)));
    expect(hl.trades.map((t) => t.id)).toEqual(["hl-4", "hl-5", "hl-6"]);
  });

  it("after a reconnect, the replay is skipped, so nothing is counted twice", () => {
    const hl = adapter();
    hl.subscribed();
    hl.feed(message(raw(1)));
    hl.feed(message(raw(2)));
    hl.feed(message(raw(3)));
    hl.subscribed(); // the SDK reconnected and resubscribed
    hl.feed(message(raw(1), raw(2), raw(3))); // replay: prints already counted
    hl.feed(message(raw(4)));
    expect(hl.trades.map((t) => t.id)).toEqual(["hl-2", "hl-3", "hl-4"]); // hl-1 was in the first replay
  });

  it("drops a trade id it has already emitted", () => {
    const hl = adapter();
    hl.feed(message(raw(1), raw(2)));
    hl.feed(message(raw(2), raw(3)));
    expect(hl.trades.map((t) => t.id)).toEqual(["hl-1", "hl-2", "hl-3"]);
  });

  it("resubscribing only the book does not skip trades", () => {
    const hl = adapter();
    hl.subscribed([{ type: "l2Book", coin: "BTC" }]);
    hl.feed(message(raw(1)));
    expect(hl.trades.map((t) => t.id)).toEqual(["hl-1"]);
  });
});

// ─── The Siebly base calls the hook whenever topics are (re)subscribed ───
class FakeClient extends EventEmitter {
  subscribe = jest.fn();
  unsubscribe = jest.fn();
}

class FakeAdapter extends SieblyAdapter<FakeClient, string> {
  readonly venue: Venue = "hyperliquid";
  protected readonly events = { data: "message", reconnecting: "reconnecting" };
  readonly fake = new FakeClient();
  readonly hookCalls: string[][] = [];
  protected async createClient(): Promise<FakeClient> { return this.fake; }
  protected disposeClient(client: FakeClient): void { client.removeAllListeners(); }
  protected topics(): string[] { return ["trades", "book"]; }
  protected bookTopics(): string[] { return ["book"]; }
  protected subscribeTopics(client: FakeClient, topics: string[]) { return client.subscribe(topics); }
  protected unsubscribeTopics(client: FakeClient, topics: string[]) { return client.unsubscribe(topics); }
  protected ackOf(): AckResult { return null; }
  protected handleMessage(): void {}
  protected onTopicsSubscribed(topics: string[]): void { this.hookCalls.push(topics); }
  resubscribeBook(): void { this.requestResubscribe(); }
}

describe("SieblyAdapter onTopicsSubscribed", () => {
  it("runs before subscribing on connect, on an SDK reconnect and on a resubscribe", async () => {
    const a = new FakeAdapter("BTC");
    try {
      a.connect();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(a.hookCalls).toEqual([["trades", "book"]]);
      expect(a.fake.subscribe).toHaveBeenCalledWith(["trades", "book"]);

      a.fake.emit("reconnecting");
      expect(a.hookCalls).toEqual([["trades", "book"], ["trades", "book"]]);

      a.resubscribeBook();
      expect(a.hookCalls.at(-1)).toEqual(["book"]);
    } finally {
      a.disconnect(); // stops the adapter's watchdog timer even when an expectation fails
    }
  });
});
