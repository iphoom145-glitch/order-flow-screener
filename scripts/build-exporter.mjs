// Bundles scripts/orderflow-exporter.ts and every package it needs into one
// file, dist/orderflow-exporter.cjs, so the headless service runs on Node
// alone (no node_modules). CommonJS output because several exchange SDKs use
// require() for Node built-ins.

import { build } from "esbuild";

await build({
  entryPoints: ["scripts/orderflow-exporter.ts"],
  outfile: "dist/orderflow-exporter.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // Optional native speed-ups of `ws`; it works without them.
  external: ["bufferutil", "utf-8-validate"],
  // Client modules carry "use client"; it means nothing outside React.
  logOverride: { "unsupported-directive": "silent" },
  logLevel: "info",
});
