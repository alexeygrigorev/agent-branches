/**
 * Cloudflare env typings (facade extraction, 2026-10-03) — moved verbatim
 * from the pre-facade src/index.ts.
 */

import type { ArtifactsNamespaceBinding } from "../artifacts/real.js";
import type { Coordinator } from "./coordinator-do.js";

declare global {
  interface Env {
    ARTIFACTS?: ArtifactsNamespaceBinding;
    RADAR_IMPL?: string;
    ADMIN_TOKEN?: string;
    RUNNER_TOKEN?: string;
    LOCAL_ARTIFACTS_URL?: string;
    LOCAL_ARTIFACTS_TOKEN?: string;
  }
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    interface Env {
      COORDINATOR: DurableObjectNamespace<Coordinator>;
      ARTIFACTS?: ArtifactsNamespaceBinding;
      RADAR_IMPL?: string;
      ADMIN_TOKEN?: string;
      RUNNER_TOKEN?: string;
      LOCAL_ARTIFACTS_URL?: string;
      LOCAL_ARTIFACTS_TOKEN?: string;
    }
  }
}
