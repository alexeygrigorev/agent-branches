/**
 * Provider-neutral HTTP routing (facade extraction, 2026-10-03).
 *
 * handleRoute is the ONE implementation of every wire route (CONTRACT.md):
 * the Cloudflare Worker fetch handler and the local node:http entry both
 * translate their platform request into the neutral HttpRequest view, call
 * handleRoute, and serialize the neutral HttpResponse. No Request/Response,
 * env bindings or Durable Object types appear here — the same statuses,
 * bodies and auth decisions are produced on every runtime.
 */

import { parseChecksPayload, type NormalizedChecksPayload } from "../checks-wire.js";
import type { PushEvents } from "../ports/push-events.js";
import {
  bearerFrom,
  decideBearer,
  decideMutatingAuth,
  decideReadAuth,
  hmacSha256Hex,
  timingSafeEqual,
  WEBHOOK_TOLERANCE_SECONDS,
  type AuthDecision,
  type AuthTokens,
  type ReadAuthOptions,
  type WebhookReplayGuard,
} from "./auth.js";
import type { CoordinatorAccess } from "./coordinator.js";

// REV-WEBHOOK-AUTH-F3F06D2: the webhook crypto primitives live in auth.ts
// next to every other authentication primitive; re-exported here so route
// callers and tests keep a single import surface.
export {
  hmacSha256Hex,
  MemoryReplayGuard,
  WEBHOOK_RETENTION_MS,
  WEBHOOK_TOLERANCE_SECONDS,
  type WebhookReplayGuard,
} from "./auth.js";

/** Runtime-agnostic request view (adapters translate to/from this). */
export interface HttpRequest {
  method: string;
  /** Path WITHOUT query string, e.g. "/tasks/task-0001/tests". */
  path: string;
  /** Case-insensitive header lookup; null when absent. */
  header(name: string): string | null;
  /** Parsed JSON body. Throws on malformed JSON (mapped to 400). */
  json(): Promise<unknown>;
  /**
   * Raw body text, while the adapter can still supply it (C1462 Task 3).
   * Required ONLY to verify HMAC-signed webhooks — the signature binds to
   * these exact bytes, so `json()` cannot be used for it (it has already
   * lost whitespace/key-order). Optional: adapters that do not implement
   * it simply cannot present signed webhooks (fail closed, 401), and
   * unsigned routes never call it. An adapter MUST NOT be asked for both
   * `rawText()` and `json()` on one request — the body stream is
   * single-shot, which is why the signed path parses the raw text itself.
   */
  rawText?(): Promise<string>;
}

/** Runtime-agnostic response (adapters serialize body as pretty JSON).
 * Optional headers travel with the response so behavior like the CORS
 * policy the review UI depends on is identical on every runtime. */
export interface HttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** The review UI (prototype/ui) is served from its own origin and fetches
 * /status cross-origin (documented ?api= usage), so responses need CORS. */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

export interface RouterServices {
  coordinator: CoordinatorAccess;
  tokens: AuthTokens;
  /** POST /events/push normalizer (agent POSTs and webhook deliveries). */
  pushes: PushEvents;
  /** POST /events/artifacts normalizer (event subscription envelopes). */
  artifactsEvents: PushEvents;
  /**
   * Inbound webhook sender authentication (C1462 Task 3). Optional: when
   * unset, only the pre-existing bearer ladder authenticates webhook
   * routes, exactly as before.
   */
  webhookAuth?: WebhookAuthConfig;
}

/**
 * C1462 Task 3 — webhook sender authentication, replay protection.
 *
 * Sender contract (the sidecar / event subscription adopts this when
 * WEBHOOK_SECRET is configured on both ends):
 *
 *   timestamp = current unix time in whole seconds
 *   nonce     = fresh opaque string per DELIVERY ATTEMPT (a retry that
 *               reuses a nonce is indistinguishable from a replay and is
 *               rejected — regenerate per attempt)
 *   signature = "sha256=" + hex(HMAC-SHA256(secret,
 *               timestamp + "." + nonce + "." + rawBody))
 *
 * The nonce is bound INTO the signature (REV-WEBHOOK-AUTH-F3F06D2): a
 * captured signature cannot be replayed under a fresh synthetic nonce,
 * because the recomputed HMAC over a different nonce will not match.
 * Replay of a byte-identical delivery (same nonce) is rejected 409.
 *
 *   POST /events/push
 *   x-webhook-timestamp: <timestamp>
 *   x-webhook-nonce: <nonce>
 *   x-webhook-signature: <signature>
 *   <rawBody is the exact request body bytes>
 *
 * Verification happens BEFORE the body is parsed (auth precedes parsing,
 * like every other route here). Any `x-webhook-signature` header on a
 * webhook route opts the request into this scheme — a failed signature is
 * never silently downgraded to the bearer ladder (fail closed). Senders
 * without the header keep using the bearer ladder unchanged (note: that
 * path predates this task and has no replay binding).
 */

/** Configuration for signed webhook verification (all optional). */
export interface WebhookAuthConfig {
  /** Shared HMAC secret (WEBHOOK_SECRET). Signed webhooks fail closed
   * (503) when it is not configured, mirroring decideBearer. */
  secret?: string;
  /** Wall clock in ms; defaults to Date.now (inject for tests). */
  nowMs?: () => number;
  /** Seen-nonce store; signed webhooks fail closed (503) without one. */
  replayGuard?: WebhookReplayGuard;
  /** Overrides WEBHOOK_TOLERANCE_SECONDS when set. */
  toleranceSeconds?: number;
}

/**
 * Verification outcome. Denials carry the exact response BODY, not just a
 * message: 401/503 are `{error}`, a detected replay is 409 Conflict with
 * `{error: "conflict", message}` (REV-WEBHOOK-AUTH-F3F06D2) — the request
 * was fully authenticated and only rejected as a duplicate, which is a
 * conflict, not an authorization failure.
 */
export type WebhookSignatureDecision =
  | { ok: true; rawBody: string }
  | { ok: false; status: 401 | 409 | 503; body: Record<string, string> };

/**
 * Verify one signed webhook against the sender contract above. Every
 * failure is fail closed and caller-safe: error bodies never contain the
 * secret, the presented signature or the nonce. Order: cheap shape checks
 * (a missing nonce is rejected BEFORE any HMAC work), freshness, replay
 * guard availability, THEN the HMAC — which binds timestamp, nonce AND
 * rawBody, so a stolen signature cannot be replayed under a substituted
 * nonce (REV-WEBHOOK-AUTH-F3F06D2). The last store mutation is the nonce
 * admit: only a fully verified delivery consumes its nonce, and only then
 * does a duplicate come back as 409 Conflict.
 */
export async function verifyWebhookSignature(
  request: HttpRequest,
  config: WebhookAuthConfig | undefined,
): Promise<WebhookSignatureDecision> {
  const deny = (status: 401 | 409 | 503, error: string, message?: string): WebhookSignatureDecision => ({
    ok: false,
    status,
    body: message === undefined ? { error } : { error, message },
  });
  if (!config?.secret) {
    return deny(503, "WEBHOOK_SECRET is not configured; refusing signed webhook (fail closed)");
  }
  if (!request.rawText) {
    return deny(401, "signed webhook cannot be verified: adapter exposes no raw body");
  }
  const rawBody = await request.rawText();

  const timestamp = request.header("x-webhook-timestamp");
  if (timestamp === null || !/^\d+$/.test(timestamp)) {
    return deny(401, "webhook timestamp header (x-webhook-timestamp, unix seconds) is required");
  }
  const toleranceSeconds = config.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((config.nowMs?.() ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) {
    return deny(401, "webhook timestamp outside tolerance window");
  }

  const nonce = request.header("x-webhook-nonce");
  if (nonce === null || nonce.length === 0 || nonce.length > 256) {
    return deny(401, "webhook nonce header (x-webhook-nonce) is required");
  }
  if (!config.replayGuard) {
    return deny(503, "webhook replay guard is not configured; refusing signed webhook (fail closed)");
  }

  const match = /^sha256=([0-9a-f]{64})$/.exec(request.header("x-webhook-signature") ?? "");
  if (!match) {
    return deny(401, "webhook signature must be sha256=<64 hex chars>");
  }
  const expected = await hmacSha256Hex(config.secret, `${timestamp}.${nonce}.${rawBody}`);
  if (!timingSafeEqual(expected, match[1])) {
    return deny(401, "webhook signature mismatch");
  }

  if (!config.replayGuard.admit(nonce)) {
    return deny(409, "conflict", "webhook replay detected: nonce already used");
  }
  return { ok: true, rawBody };
}

type ParsedBody = { ok: true; body: Record<string, unknown> } | { ok: false; response: HttpResponse };

/** Signed-webhook bodies are parsed from the verified raw text (a request
 * body stream cannot be consumed twice), with the same 400 as readJson. */
function parseJsonBody(raw: string): ParsedBody {
  try {
    return { ok: true, body: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { ok: false, response: json({ error: "request body must be valid JSON" }, 400) };
  }
}

function json(body: unknown, status = 200): HttpResponse {
  return { status, body, headers: { ...CORS_HEADERS } };
}

async function readJson(request: HttpRequest): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function deniedOrOk(decision: AuthDecision): HttpResponse | null {
  if (decision.ok) {
    return null;
  }
  return json(
    decision.message === undefined ? { error: decision.error } : { error: decision.error, message: decision.message },
    decision.status,
  );
}

async function requireBearer(
  request: HttpRequest,
  expected: string | undefined,
  envName: "ADMIN_TOKEN" | "RUNNER_TOKEN",
): Promise<HttpResponse | null> {
  return deniedOrOk(await decideBearer(bearerFrom(request.header("authorization")), expected, envName));
}

async function requireMutatingAuth(
  request: HttpRequest,
  services: RouterServices,
  opts: { agent?: string | null; allowSidecar?: boolean } = {},
): Promise<HttpResponse | null> {
  return deniedOrOk(
    await decideMutatingAuth(
      bearerFrom(request.header("authorization")),
      services.tokens,
      opts,
      (presented) => services.coordinator.credentialAgent(presented),
    ),
  );
}

/** C1462 Task 1: read endpoints authenticate like everything else; pass
 * `agent` to narrow a task read to its owner (or admin). */
async function requireReadAuth(
  request: HttpRequest,
  services: RouterServices,
  opts: ReadAuthOptions = {},
): Promise<HttpResponse | null> {
  return deniedOrOk(
    await decideReadAuth(
      bearerFrom(request.header("authorization")),
      services.tokens,
      opts,
      (presented) => services.coordinator.credentialAgent(presented),
    ),
  );
}

/**
 * Error mapping, verbatim from the pre-facade Worker handler: known
 * caller mistakes are 400, unknown task/warning 404, everything else 500.
 * C1462 Task 3 redaction: 500 means an UNEXPECTED internal failure, whose
 * message may carry paths, hostnames, connection strings or stack-derived
 * text — callers get a fixed body, never the internal message or a stack.
 * Runtime adapters should log `error` server-side where a log exists.
 * The 400/404 messages are an explicit allowlist of caller-safe strings.
 */
function errorResponse(error: unknown): HttpResponse {
  const message = (error as Error).message ?? "internal error";
  if (/^unknown (task|warning)/.test(message)) {
    return json({ error: message }, 404);
  }
  const status = /^(unknown agent|fork |commit |repo already|repo not found|request body|unsupported event|missing artifacts|pushed payload|invalid radar status|invalid radar kind|check result requires|runner results must|result heads|results must|base_sha|test provenance|command \(string\)|no Artifacts backend)/.test(
    message,
  )
    ? 400
    : 500;
  if (status === 500) {
    return json({ error: "internal server error" }, 500);
  }
  return json({ error: message }, status);
}

export async function handleRoute(services: RouterServices, request: HttpRequest): Promise<HttpResponse> {
  const path = request.path;
  const method = request.method;
  const coordinator = services.coordinator;

  try {
    if (method === "OPTIONS") {
      return {
        status: 204,
        body: null,
        headers: { ...CORS_HEADERS, "access-control-max-age": "86400" },
      };
    }

    if (method === "POST" && path === "/setup") {
      const denied = await requireBearer(request, services.tokens.admin, "ADMIN_TOKEN");
      if (denied) {
        return denied;
      }
      return json(await coordinator.setup(), 201);
    }

    if (method === "POST" && path === "/tasks") {
      const denied = await requireBearer(request, services.tokens.admin, "ADMIN_TOKEN");
      if (denied) {
        return denied;
      }
      const body = await readJson(request);
      const created = await coordinator.createTask({
        agent: typeof body.agent === "string" ? body.agent : undefined,
        intent: typeof body.intent === "string" ? body.intent : undefined,
        baseSha: typeof body.base_sha === "string" ? body.base_sha : undefined,
        ttlSeconds: typeof body.ttlSeconds === "number" ? body.ttlSeconds : undefined,
      });
      return json(created, 201);
    }

    if (method === "POST" && path === "/events/push") {
      // C1462 Task 3: a request presenting x-webhook-signature opts into
      // HMAC sender verification (before the body is parsed or trusted);
      // a failed signature is never downgraded to the bearer ladder.
      let body: Record<string, unknown>;
      let signed = false;
      if (request.header("x-webhook-signature") !== null) {
        const verdict = await verifyWebhookSignature(request, services.webhookAuth);
        if (!verdict.ok) {
          return json(verdict.body, verdict.status);
        }
        const parsed = parseJsonBody(verdict.rawBody);
        if (!parsed.ok) {
          return parsed.response;
        }
        body = parsed.body;
        signed = true;
      } else {
        body = await readJson(request);
      }
      // Either agent or fork identifies the pusher: the sidecar's
      // post-receive webhook posts {fork, ref, sha} (C-1309 #7a).
      let push;
      try {
        push = services.pushes.normalize(body);
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
      // muse-r46 AUTH: head advances are privileged (an anonymous caller
      // could invalidate/suppress conflict warnings). The pushing agent's
      // own task token, ADMIN_TOKEN, or the sidecar webhook bearer.
      // A verified HMAC signature is the sidecar's sender credential
      // itself (stronger than the shared bearer: body-bound + replay-
      // protected) and grants the same trust, so the ladder is skipped.
      if (!signed) {
        const requiredAgent = push.agent ?? (push.fork !== undefined ? await coordinator.forkOwner(push.fork) : undefined);
        const denied = await requireMutatingAuth(request, services, { agent: requiredAgent, allowSidecar: true });
        if (denied) {
          return denied;
        }
      }
      const result = await coordinator.recordPush({
        agent: push.agent,
        fork: push.fork,
        ref: push.ref,
        sha: push.sha,
      });
      return json(result);
    }

    if (method === "POST" && path === "/events/artifacts") {
      // C1462 Task 3: same signed-webhook opt-in as /events/push.
      let body: Record<string, unknown>;
      let signed = false;
      if (request.header("x-webhook-signature") !== null) {
        const verdict = await verifyWebhookSignature(request, services.webhookAuth);
        if (!verdict.ok) {
          return json(verdict.body, verdict.status);
        }
        const parsed = parseJsonBody(verdict.rawBody);
        if (!parsed.ok) {
          return parsed.response;
        }
        body = parsed.body;
        signed = true;
      } else {
        // muse-r46 AUTH: event-subscription ingest is webhook-only — admin
        // or the sidecar/shared subscription bearer (no agent credential).
        const denied = await requireMutatingAuth(request, services, { allowSidecar: true });
        if (denied) {
          return denied;
        }
        body = await readJson(request);
      }
      let event;
      try {
        event = services.artifactsEvents.normalize(body);
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
      const status = await coordinator.status();
      const agent = status.agents.find(
        (candidate) => candidate.forkName === event.fork || candidate.forkRemote === event.fork,
      );
      if (!agent) {
        return json({ accepted: false, reason: `no agent owns fork ${event.fork}` }, 202);
      }
      const result = await coordinator.recordPush({
        agent: agent.agentId,
        fork: agent.forkName,
        ref: event.ref,
        sha: event.sha,
      });
      return json(result);
    }

    if (method === "POST" && path === "/checks") {
      const denied = await requireBearer(request, services.tokens.runner, "RUNNER_TOKEN");
      if (denied) {
        return denied;
      }
      const body = await readJson(request);
      // C-1350: the payload declares its wire — contract "0.1" is the
      // canonical typed shape (L3 export_l1_payload), "0.0" the legacy
      // string adapter; anything else (incl. no contract field) is 400.
      let parsed: NormalizedChecksPayload;
      try {
        parsed = parseChecksPayload(body);
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
      const outcome = await coordinator.submitChecks(parsed);
      if (outcome.stale) {
        return json(
          {
            error: "stale vector: heads have moved since the runner fetched them; re-fetch /status and retry",
            currentHeads: outcome.currentHeads,
          },
          409,
        );
      }
      return json(outcome);
    }

    if (method === "GET" && path === "/status") {
      // C1462 Task 1: /status is no longer open — admin, runner (it fetches
      // the heads vector before POST /checks) or any valid agent task token;
      // expiry and revocation gates apply.
      const denied = await requireReadAuth(request, services);
      if (denied) {
        return denied;
      }
      return json(await coordinator.status());
    }

    const taskMatch = /^\/tasks\/([^/]+)$/.exec(path);
    if (method === "GET" && taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]);
      // C1462 Task 1: a task read is owner-or-admin (valid foreign token is
      // 403). Auth resolves before existence: anonymous callers cannot probe
      // task ids (same shape as POST /tasks/:id/revoke, C-1425). Unknown
      // tasks narrow nothing, so any valid read credential reaches the 404.
      const owner = await coordinator.taskOwner(taskId);
      const denied = await requireReadAuth(request, services, owner === null ? {} : { agent: owner });
      if (denied) {
        return denied;
      }
      try {
        return json(await coordinator.getTask(taskId));
      } catch (error) {
        if ((error as Error).message.startsWith("unknown task")) {
          return json({ error: (error as Error).message }, 404);
        }
        throw error;
      }
    }

    const taskTestsMatch = /^\/tasks\/([^/]+)\/tests$/.exec(path);
    if (method === "POST" && taskTestsMatch) {
      const taskId = decodeURIComponent(taskTestsMatch[1]);
      // muse-r46 AUTH (evidence forgery, review §a.2): only the owning
      // agent's task token or ADMIN_TOKEN may attach test provenance.
      const owner = await coordinator.taskOwner(taskId);
      if (owner === null) {
        return json({ error: `unknown task: ${taskId}` }, 404);
      }
      const denied = await requireMutatingAuth(request, services, { agent: owner });
      if (denied) {
        return denied;
      }
      const body = await readJson(request);
      if (typeof body.command !== "string" || typeof body.exit !== "number" || typeof body.head_sha !== "string") {
        return json({ error: "command (string), exit (number) and head_sha (string) are required" }, 400);
      }
      const result = await coordinator.recordTestProvenance(taskId, {
        command: body.command,
        exit: body.exit,
        head_sha: body.head_sha,
      });
      return json(result, 201);
    }

    const ackMatch = /^\/warnings\/([^/]+)\/ack$/.exec(path);
    if (method === "POST" && ackMatch) {
      const body = await readJson(request);
      if (typeof body.agent !== "string" || body.agent.length === 0) {
        return json({ error: "agent is a required string" }, 400);
      }
      // muse-r46 AUTH: the acking agent authenticates with its own task
      // token (or ADMIN_TOKEN) — agent A cannot ack as agent B. The ack is
      // attestational, so the sidecar bearer is NOT accepted here.
      const denied = await requireMutatingAuth(request, services, { agent: body.agent });
      if (denied) {
        return denied;
      }
      const result = await coordinator.ackWarning(decodeURIComponent(ackMatch[1]), {
        agent: body.agent,
        note: typeof body.note === "string" ? body.note : undefined,
      });
      return json(result);
    }

    const taskRevokeMatch = /^\/tasks\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && taskRevokeMatch) {
      // C-1425: token revocation is an admin control — ADMIN_TOKEN only
      // (auth first, so task-id probing is not available to unauthenticated
      // callers), then the task must exist.
      const denied = await requireBearer(request, services.tokens.admin, "ADMIN_TOKEN");
      if (denied) {
        return denied;
      }
      const taskId = decodeURIComponent(taskRevokeMatch[1]);
      const owner = await coordinator.taskOwner(taskId);
      if (owner === null) {
        return json({ error: `unknown task: ${taskId}` }, 404);
      }
      const revoked = await coordinator.revokeAgentToken(owner);
      return json({ taskId, agentId: owner, revoked });
    }

    return json({ error: `no route for ${method} ${path}` }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}
