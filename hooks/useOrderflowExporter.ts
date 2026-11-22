"use client";

import { useEffect } from "react";
import { useSessionStoreApi } from "@/lib/session/SessionContext";
import { OrderflowExporter } from "@/lib/export/orderflowExporter";

// ─── Hook: useOrderflowExporter ──────────────────────────────────
// Runs the BTCUSDT all-perps snapshot exporter for as long as the
// dashboard is open. NEXT_PUBLIC_ORDERFLOW_EXPORT=0 turns it off;
// NEXT_PUBLIC_ORDERFLOW_EXPORT_INTERVAL_MS sets the period (default 60 s).
// The destination folder is the server's ORDERFLOW_EXPORT_DIR.

const ENABLED = process.env.NEXT_PUBLIC_ORDERFLOW_EXPORT !== "0";
const INTERVAL_MS = Number(process.env.NEXT_PUBLIC_ORDERFLOW_EXPORT_INTERVAL_MS) || 60_000;

export function useOrderflowExporter(): void {
  const dashboard = useSessionStoreApi();

  useEffect(() => {
    if (!ENABLED) return;
    const exporter = new OrderflowExporter({ dashboard, intervalMs: INTERVAL_MS });
    exporter.start();
    return () => exporter.dispose();
  }, [dashboard]);
}
