/**
 * Compat shim (facade extraction, 2026-10-03): the sidecar GitHost adapter
 * moved to src/local/githost.ts. No behavior change.
 */

export { SidecarArtifacts, type FetchLike } from "../local/githost.js";
