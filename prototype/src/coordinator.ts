/**
 * Compat shim (facade extraction, 2026-10-03): the coordinator logic moved
 * to src/core/coordinator.ts (provider-neutral CoordinatorCore) and the
 * Cloudflare Durable Object wrapper to src/cloudflare/coordinator-do.ts.
 * These re-exports keep every pre-facade import path working — no behavior
 * change. New code imports from src/core/ (logic) or src/cloudflare/
 * (Cloudflare composition) directly.
 */

export { SEEN_PUSHES_CAP_PER_AGENT } from "./core/model.js";
export { sha256Hex, timingSafeEqual } from "./core/auth.js";
export { Coordinator } from "./cloudflare/coordinator-do.js";
