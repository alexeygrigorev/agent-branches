/**
 * Cloudflare GitHost adapter (facade extraction, 2026-10-03).
 *
 * RealArtifacts (src/artifacts/real.ts) IS the GitHost implementation for
 * Cloudflare — kept verbatim, no behavior change (ArtifactsPort is now an
 * alias of the GitHost port). The only new code is the env-based factory
 * that used to live in the Coordinator DO.
 */

import { RealArtifacts } from "../artifacts/real.js";
import { SidecarArtifacts } from "../local/githost.js";
import type { GitHost } from "../ports/githost.js";

export { RealArtifacts, type ArtifactsNamespaceBinding } from "../artifacts/real.js";

/**
 * Deployment boundary (codex C-1309): the Worker/DO never runs git. It
 * talks to either the real Artifacts binding or the local Node sidecar.
 */
export function gitHostFromEnv(env: Env): GitHost {
  if (env.ARTIFACTS) {
    return new RealArtifacts(env.ARTIFACTS);
  }
  if (env.LOCAL_ARTIFACTS_URL) {
    return new SidecarArtifacts(env.LOCAL_ARTIFACTS_URL, env.LOCAL_ARTIFACTS_TOKEN);
  }
  throw new Error(
    "no Artifacts backend configured: set the ARTIFACTS binding (real) or LOCAL_ARTIFACTS_URL (local sidecar)",
  );
}
