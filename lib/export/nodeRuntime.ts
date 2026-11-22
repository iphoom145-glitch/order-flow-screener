// ============================================================
// NODE RUNTIME (headless service only)
// In the browser the HTX and KuCoin adapters call the app's own
// /api/htx and /api/kucoin proxies (those exchanges send no CORS
// headers). The headless service has no web server, so relative /api/
// requests are answered by the same route handlers in process; every
// other request goes out unchanged.
// ============================================================

import { GET as htxGet } from "@/app/api/htx/route";
import { GET as kucoinGet, POST as kucoinPost } from "@/app/api/kucoin/route";

type RouteHandler = (request: never) => Promise<Response>;

const ROUTES: Record<string, Record<string, RouteHandler>> = {
  "/api/htx": { GET: htxGet as unknown as RouteHandler },
  "/api/kucoin": { GET: kucoinGet as unknown as RouteHandler, POST: kucoinPost as unknown as RouteHandler },
};

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** Answer relative /api/ requests in process. Returns a function that restores the previous fetch. */
export function installApiShim(): () => void {
  const original = globalThis.fetch;
  const shim = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (!url.startsWith("/api/")) return original(input, init);
    const full = new URL(url, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const handler = ROUTES[full.pathname]?.[method];
    if (!handler) return Response.json({ error: `No handler for ${method} ${full.pathname}` }, { status: 404 });
    // The handlers only read `request.nextUrl.searchParams`.
    return handler({ nextUrl: full, method, headers: new Headers(init?.headers) } as never);
  };
  globalThis.fetch = shim as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
