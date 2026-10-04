/**
 * Provider-neutral push-notification ingestion (facade extraction,
 * 2026-10-03): every source of "a head moved" news — an agent POSTing
 * /events/push, the local sidecar's post-receive webhook, or a Cloudflare
 * Artifacts event subscription — is normalized into ONE PushEvent shape
 * before the coordinator sees it.
 */

import type { GitAuthor } from "./githost.js";

export type PushEventOrigin = "direct" | "webhook" | "artifacts";

/** The one normalized push shape the coordinator accepts. */
export interface PushEvent {
  origin: PushEventOrigin;
  /** Pushing agent id, when the caller identified itself that way. */
  agent?: string;
  /** Fork name or remote URL, when the caller identified the repo instead. */
  fork?: string;
  ref?: string;
  sha: string;
}

export interface PushEvents {
  /**
   * Normalize one incoming notification. Throws an Error with a
   * caller-safe message (routes map it to 400) on malformed input.
   */
  normalize(raw: unknown): PushEvent;
}

/**
 * The direct JSON shape shared by agent POSTs ({agent, ref, sha}) and the
 * sidecar's post-receive webhook ({fork, ref, sha}) — codex C-1309 #7a.
 * Validation is exactly the route's pre-facade check: agent or fork (at
 * least one) plus a sha, all strings.
 */
export class JsonPushEvents implements PushEvents {
  private readonly origin: PushEventOrigin;

  constructor(origin: PushEventOrigin = "webhook") {
    this.origin = origin;
  }

  normalize(raw: unknown): PushEvent {
    const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const agent = typeof body.agent === "string" ? body.agent : undefined;
    const fork = typeof body.fork === "string" ? body.fork : undefined;
    if ((agent === undefined && fork === undefined) || typeof body.sha !== "string") {
      throw new Error("agent or fork, and sha are required strings");
    }
    return {
      origin: this.origin,
      agent,
      fork,
      ref: typeof body.ref === "string" ? body.ref : undefined,
      sha: body.sha,
    };
  }
}

/** Cloudflare Artifacts event-subscription envelope (cf.artifacts.repo.pushed). */
export interface ArtifactsPushedEvent {
  type: "cf.artifacts.repo.pushed";
  source: {
    type: "artifacts.repo";
    namespace: string;
    repoName: string;
  };
  payload: {
    ref: string;
    before: string;
    after: string;
    commits: {
      id: string;
      message: string;
      messageTruncated: boolean;
      timestamp: string;
      author?: GitAuthor;
      committer?: GitAuthor;
      parents: string[];
    }[];
    totalCommitsCount: number;
    commitsTruncated: boolean;
  };
  metadata: {
    accountId: string;
    eventSubscriptionId: string;
    eventSchemaVersion: number;
    eventTimestamp: string;
  };
}

/** Verbatim pre-facade envelope parser (moved from src/types.ts). */
export function parseArtifactsPushedEvent(body: unknown): ArtifactsPushedEvent {
  if (typeof body !== "object" || body === null) {
    throw new Error("event body must be an object");
  }
  const candidate = body as Partial<ArtifactsPushedEvent> & { payload?: Partial<ArtifactsPushedEvent["payload"]> };
  if (candidate.type !== "cf.artifacts.repo.pushed") {
    throw new Error(`unsupported event type: ${String(candidate.type)}`);
  }
  const source = candidate.source;
  const payload = candidate.payload;
  if (!source || source.type !== "artifacts.repo" || typeof source.repoName !== "string") {
    throw new Error("missing artifacts.repo source");
  }
  if (!payload || typeof payload.ref !== "string" || typeof payload.after !== "string") {
    throw new Error("pushed payload requires ref and after");
  }
  return candidate as ArtifactsPushedEvent;
}

/** Adapter for the Artifacts event subscription (used by both runtimes). */
export class ArtifactsPushEvents implements PushEvents {
  normalize(raw: unknown): PushEvent {
    const event = parseArtifactsPushedEvent(raw);
    return { origin: "artifacts", fork: event.source.repoName, ref: event.payload.ref, sha: event.payload.after };
  }
}
