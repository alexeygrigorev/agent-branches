/**
 * Local push-event adapters (facade extraction, 2026-10-03): the sidecar's
 * post-receive webhook delivers the direct JSON shape ({fork, ref, sha});
 * the artifacts-envelope normalizer is kept identical to the Worker's so
 * both runtimes accept both ingest routes.
 */

import { ArtifactsPushEvents, JsonPushEvents } from "../ports/push-events.js";
import type { PushEvents } from "../ports/push-events.js";

/** POST /events/push: post-receive webhook deliveries (and direct agent POSTs). */
export const webhookPushEvents: PushEvents = new JsonPushEvents("webhook");

/** POST /events/artifacts: envelope parity with the Cloudflare runtime. */
export const localArtifactsPushEvents: PushEvents = new ArtifactsPushEvents();
