/**
 * Cloudflare push-event adapters (facade extraction, 2026-10-03): which
 * normalizer serves which ingest route on the Worker. Both wrap pure
 * parsers from src/ports/push-events.ts; a different event source (e.g.
 * Gitea webhooks) would add a PushEvents implementation, not a route.
 */

import { ArtifactsPushEvents, JsonPushEvents } from "../ports/push-events.js";
import type { PushEvents } from "../ports/push-events.js";

/** POST /events/push: agent POSTs (direct) and the sidecar post-receive webhook. */
export const directPushEvents: PushEvents = new JsonPushEvents("direct");

/** POST /events/artifacts: the Cloudflare Artifacts event subscription. */
export const artifactsPushEvents: PushEvents = new ArtifactsPushEvents();
