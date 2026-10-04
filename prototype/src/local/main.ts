/**
 * Minimal Node runtime entry (facade extraction, 2026-10-03): serves the
 * coordinator's routes from the provider-neutral core over node:http with
 * NO dependencies (node:http / node:fs/promises only) and NO Cloudflare.
 *
 * Example:
 *   LOCAL_ARTIFACTS_URL=http://127.0.0.1:6495 \
 *   LOCAL_ARTIFACTS_TOKEN=... ADMIN_TOKEN=... RUNNER_TOKEN=... \
 *   node --experimental-strip-types src/local/main.ts
 *
 * Contract parity with the Worker (CONTRACT.md): same routes, same auth
 * env names, same bodies. State persists in a local JSON file by default;
 * point COORDINATOR_STATE_FILE elsewhere for a separate instance.
 */

import { pathToFileURL } from "node:url";
import { CoordinatorCore } from "../core/coordinator.js";
import type { RouterServices } from "../core/router.js";
import { cryptoIds, systemClock } from "../ports/clock.js";
import { radarFromEnv } from "../radar.js";
import { SidecarArtifacts } from "./githost.js";
import { localArtifactsPushEvents, webhookPushEvents } from "./push-events.js";
import { serveCoordinator, type NodeServerLike } from "./runtime.js";
import { FileCoordinationStore } from "./store.js";

export interface LocalRuntimeOptions {
  env?: Record<string, string | undefined>;
  /** Injectable for tests (defaults to the real node:http server). */
  serve?: (services: RouterServices) => NodeServerLike;
}

export async function startLocalRuntime(options: LocalRuntimeOptions = {}): Promise<NodeServerLike> {
  const env = options.env ?? process.env;
  const sidecarUrl = env.LOCAL_ARTIFACTS_URL;
  if (!sidecarUrl) {
    throw new Error("LOCAL_ARTIFACTS_URL is required (git sidecar base URL)");
  }
  const core = new CoordinatorCore({
    store: new FileCoordinationStore(env.COORDINATOR_STATE_FILE ?? "local-coordinator-state.json"),
    git: new SidecarArtifacts(sidecarUrl, env.LOCAL_ARTIFACTS_TOKEN),
    radar: radarFromEnv(env.RADAR_IMPL),
    clock: systemClock,
    ids: cryptoIds,
  });
  const services: RouterServices = {
    coordinator: core,
    tokens: {
      admin: env.ADMIN_TOKEN,
      runner: env.RUNNER_TOKEN,
      sidecar: env.LOCAL_ARTIFACTS_TOKEN,
    },
    pushes: webhookPushEvents,
    artifactsEvents: localArtifactsPushEvents,
  };
  const server = (options.serve ?? serveCoordinator)(services);
  const port = Number(env.PORT ?? 8787);
  const host = env.HOST ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return server;
}

/* Run only when executed directly (not when imported by tests). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLocalRuntime().then(
    (server) => {
      const address = server.address();
      console.error(`[local-coordinator] listening on http://127.0.0.1:${address?.port ?? "?"}`);
    },
    (error: Error) => {
      console.error(`[local-coordinator] failed to start: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
