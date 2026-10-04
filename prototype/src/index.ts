/**
 * Cloudflare Workers entry (facade composition, 2026-10-03): wires the
 * provider-neutral core (src/core/) to the Cloudflare adapters
 * (src/cloudflare/). The wire (CONTRACT.md) is unchanged; the same routes
 * also run on plain Node via src/local/main.ts.
 */

import "./cloudflare/env.js";

export { Coordinator } from "./cloudflare/coordinator-do.js";
export type { FetchHandler } from "./cloudflare/worker.js";
export { default } from "./cloudflare/worker.js";
