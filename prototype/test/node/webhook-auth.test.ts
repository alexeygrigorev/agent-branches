/**
 * C1462 Task 3 — webhook sender authentication, timestamp/nonce replay
 * protection and error redaction, over the neutral router (plain
 * node --test, no HTTP platform).
 *
 * Sender contract under test (the sidecar / event subscription adopts
 * this when WEBHOOK_SECRET is configured on both ends):
 *
 *   x-webhook-timestamp: unix seconds
 *   x-webhook-nonce:     fresh opaque string per DELIVERY ATTEMPT
 *   x-webhook-signature: "sha256=" + hex(HMAC-SHA256(secret,
 *                        ts + "." + nonce + "." + rawBody))
 *
 * The nonce is bound into the signature (REV-WEBHOOK-AUTH-F3F06D2): a
 * captured signature fails under ANY other nonce, so the only replay that
 * reaches the guard is byte-identical — rejected 409 Conflict.
 *
 * Non-vacuous discipline (cf. C-1437): every negative case below is
 * preceded by a positive acceptance through the SAME request builder, so
 * a builder bug cannot fake a passing rejection suite.
 */

import { test } from "node:test";
import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import {
  handleRoute,
  MemoryReplayGuard,
  WEBHOOK_RETENTION_MS,
  WEBHOOK_TOLERANCE_SECONDS,
  type HttpResponse,
  type RouterServices,
} from "../../src/core/router.js";
import { makeRig, neutralRequest, type TestRig } from "./fakes.js";

const SECRET = "whsec-test-1234567890abcdef";
const NOW_MS = Date.parse("2026-10-04T12:00:00.000Z");

/** Sender-side stand-in: independent HMAC-SHA256 hex of the payload.
 * (Local structural type — the workspace crypto shim only declares digest.) */
async function hmacHex(secret: string, payload: string): Promise<string> {
  const encoded = new TextEncoder();
  const subtle = crypto.subtle as unknown as {
    importKey(
      format: "raw",
      keyData: Uint8Array,
      algorithm: { name: "HMAC"; hash: "SHA-256" },
      extractable: false,
      usages: ["sign"],
    ): Promise<unknown>;
    sign(algorithm: { name: "HMAC" }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  };
  const key = await subtle.importKey(
    "raw",
    encoded.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await subtle.sign({ name: "HMAC" }, key, encoded.encode(payload));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface WebhookRig {
  rig: TestRig;
  guard: MemoryReplayGuard;
  nowSeconds(): number;
  /** Move the fake clock forward (guard and verify config share it). */
  advance(ms: number): void;
}

/** Rig with the webhook auth config wired (injectable clock + guard). */
function webhookRig(): WebhookRig {
  const rig = makeRig();
  let nowMs = NOW_MS;
  const guard = new MemoryReplayGuard({ nowMs: () => nowMs });
  rig.services.webhookAuth = { secret: SECRET, nowMs: () => nowMs, replayGuard: guard };
  return {
    rig,
    guard,
    nowSeconds: () => Math.floor(nowMs / 1000),
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

async function createTask(rig: TestRig, agent: string): Promise<{ agentId: string; fork: { name: string } }> {
  const created = await handleRoute(rig.services, neutralRequest("POST", "/tasks", { agent }, "admin-t"));
  strictEqual(created.status, 201);
  return created.body as { agentId: string; fork: { name: string } };
}

/**
 * Build one signed webhook request through handleRoute. Defaults are the
 * happy path: fresh timestamp at NOW, nonce "n-1", signature computed
 * over the exact `raw` bytes with SECRET, rawText provided.
 */
async function signedWebhook(
  services: RouterServices,
  opts: {
    path?: string;
    /** Exact body bytes as delivered. */
    raw: string;
    /** Override the signing secret (default SECRET). */
    signingSecret?: string;
    /** Override the signature header; null omits the header entirely. */
    signature?: string | null;
    /** Full timestamp header value; null omits the header. */
    timestampHeader?: string | null;
    /** Nonce value; null omits the header. */
    nonce?: string | null;
    /** Whether the fake adapter exposes rawText (default true). */
    withRawText?: boolean;
  },
): Promise<HttpResponse> {
  const timestamp = opts.timestampHeader === undefined ? String(Math.floor(NOW_MS / 1000)) : opts.timestampHeader;
  const nonce = opts.nonce === undefined ? "n-1" : opts.nonce;
  const signature =
    opts.signature === null
      ? null
      : (opts.signature ??
        `sha256=${await hmacHex(opts.signingSecret ?? SECRET, `${timestamp}.${nonce}.${opts.raw}`)}`);
  const headers: Record<string, string> = {};
  if (timestamp !== null) {
    headers["x-webhook-timestamp"] = timestamp;
  }
  if (nonce !== null) {
    headers["x-webhook-nonce"] = nonce;
  }
  if (signature !== null) {
    headers["x-webhook-signature"] = signature;
  }
  const provideRaw = opts.withRawText ?? true;
  return handleRoute(services, {
    method: "POST",
    path: opts.path ?? "/events/push",
    header: (name) => headers[name.toLowerCase()] ?? null,
    json: async () => JSON.parse(opts.raw),
    ...(provideRaw ? { rawText: async () => opts.raw } : {}),
  });
}

function errorOf(res: HttpResponse): string {
  return (res.body as { error?: string }).error ?? "";
}

async function commitRaw(rig: TestRig, fork: string, message: string): Promise<string> {
  return rig.git.commit(fork, message);
}

test("webhook auth: valid signature accepted WITHOUT bearer, records the push (non-vacuous positive)", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "sender");
  const sha = await commitRaw(h.rig, task.fork.name, "wip: signed delivery");
  const raw = JSON.stringify({ fork: task.fork.name, ref: "refs/heads/main", sha });
  const res = await signedWebhook(h.rig.services, { raw });
  strictEqual(res.status, 200);
  strictEqual((res.body as { accepted: boolean }).accepted, true);
  strictEqual((res.body as { agent: string }).agent, task.agentId);
});

test("webhook auth: tampered body fails HMAC though it parses to a valid push", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "tamper");
  const sha = await commitRaw(h.rig, task.fork.name, "wip");
  const signedRaw = JSON.stringify({ fork: task.fork.name, ref: "refs/heads/main", sha });
  // Delivered bytes differ from signed bytes (key order shuffled): same
  // parsed object, different wire bytes — the signature must not match.
  const delivered = JSON.stringify({ sha, ref: "refs/heads/main", fork: task.fork.name });
  ok(delivered !== signedRaw);
  const signature = `sha256=${await hmacHex(SECRET, `${Math.floor(NOW_MS / 1000)}.n-1.${signedRaw}`)}`;
  const res = await signedWebhook(h.rig.services, { raw: delivered, signature });
  strictEqual(res.status, 401);
  strictEqual(errorOf(res), "webhook signature mismatch");
  const text = JSON.stringify(res.body);
  ok(!text.includes(SECRET), "secret must never appear in a response body");
  ok(!text.includes(signature), "presented signature must never be echoed");
});

test("webhook auth: signature from a different shared secret is 401", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "wrongsecret");
  const raw = JSON.stringify({ fork: task.fork.name, sha: await commitRaw(h.rig, task.fork.name, "wip 1") });
  strictEqual((await signedWebhook(h.rig.services, { raw })).status, 200); // positive first

  const raw2 = JSON.stringify({ fork: task.fork.name, sha: await commitRaw(h.rig, task.fork.name, "wip 2") });
  const bad = await signedWebhook(h.rig.services, { raw: raw2, signingSecret: "not-the-shared-secret" });
  strictEqual(bad.status, 401);
  strictEqual(errorOf(bad), "webhook signature mismatch");
});

test("webhook auth: missing or non-integer timestamp header is 401", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "tshape");
  const raw = JSON.stringify({ fork: task.fork.name, sha: await commitRaw(h.rig, task.fork.name, "wip") });
  strictEqual((await signedWebhook(h.rig.services, { raw })).status, 200); // positive first

  for (const header of [null, "", "not-a-number", "12.5", "-100", "1e9"]) {
    const res = await signedWebhook(h.rig.services, { raw, timestampHeader: header });
    strictEqual(res.status, 401, `timestamp header ${JSON.stringify(header)} must be rejected`);
    match(errorOf(res), /timestamp/);
  }
});

test("webhook auth: timestamp tolerance boundary — ±300s accepted, ±301s rejected", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "tolerance");
  const base = h.nowSeconds();
  const attempt = async (offset: number) => {
    const sha = await commitRaw(h.rig, task.fork.name, `wip offset ${offset}`);
    return signedWebhook(h.rig.services, {
      raw: JSON.stringify({ fork: task.fork.name, sha }),
      timestampHeader: String(base + offset),
      nonce: `n-offset-${offset}`,
    });
  };
  strictEqual((await attempt(-WEBHOOK_TOLERANCE_SECONDS)).status, 200);
  strictEqual((await attempt(WEBHOOK_TOLERANCE_SECONDS)).status, 200);
  strictEqual((await attempt(-(WEBHOOK_TOLERANCE_SECONDS + 1))).status, 401);
  const stale = await attempt(-(WEBHOOK_TOLERANCE_SECONDS + 2));
  match(errorOf(stale), /outside tolerance window/);
  const fromFuture = await attempt(WEBHOOK_TOLERANCE_SECONDS + 1);
  match(errorOf(fromFuture), /outside tolerance window/);
});

test("webhook auth: duplicate nonce rejected as 409 CONFLICT even with a fresh valid signature", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "replay");
  const base = h.nowSeconds();
  const deliver = async (sha: string, nonce: string, ts: string) =>
    signedWebhook(h.rig.services, {
      raw: JSON.stringify({ fork: task.fork.name, sha }),
      nonce,
      timestampHeader: ts,
    });

  const sha1 = await commitRaw(h.rig, task.fork.name, "wip 1");
  strictEqual((await deliver(sha1, "nonce-dupe", String(base))).status, 200);

  // Same nonce, DIFFERENT fresh in-window delivery: still a replay — and
  // per REV-WEBHOOK-AUTH-F3F06D2 a CONFLICT (authenticated duplicate),
  // not an authorization failure.
  const sha2 = await commitRaw(h.rig, task.fork.name, "wip 2");
  const replay = await deliver(sha2, "nonce-dupe", String(base + 5));
  strictEqual(replay.status, 409);
  deepStrictEqual(replay.body, { error: "conflict", message: "webhook replay detected: nonce already used" });

  // Byte-for-byte captured redelivery of the first delivery: also 409
  // (HMAC valid — the nonce is what catches it).
  const captured = await deliver(sha1, "nonce-dupe", String(base));
  strictEqual(captured.status, 409);
  deepStrictEqual(captured.body, { error: "conflict", message: "webhook replay detected: nonce already used" });

  // A distinct nonce is a distinct delivery and is accepted.
  const sha3 = await commitRaw(h.rig, task.fork.name, "wip 3");
  strictEqual((await deliver(sha3, "nonce-fresh", String(base))).status, 200);
});

test("webhook auth: nonce retention strictly outlives a max-future envelope (C1506 replay hypothesis)", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "retention");
  const base = h.nowSeconds();
  const deliver = (sha: string, nonce: string, ts: string) =>
    signedWebhook(h.rig.services, {
      raw: JSON.stringify({ fork: task.fork.name, sha }),
      nonce,
      timestampHeader: ts,
    });

  // Non-vacuous positive: envelope stamped at the maximum future skew the
  // timestamp check accepts is accepted here.
  const sha = await commitRaw(h.rig, task.fork.name, "wip future-stamped");
  const futureTs = String(base + WEBHOOK_TOLERANCE_SECONDS);
  strictEqual((await deliver(sha, "nonce-future-edge", futureTs)).status, 200);

  // At first-seen + 2×tolerance the envelope is STILL signature-valid, so
  // the captured delivery must still be a 409 replay: retention may not
  // expire the nonce at the same instant the signature remains acceptable
  // (codex-principal C1506 source-derived hypothesis).
  h.advance(2 * WEBHOOK_TOLERANCE_SECONDS * 1000);
  strictEqual((await deliver(sha, "nonce-future-edge", futureTs)).status, 409);

  // Once retention lapses the nonce is forgotten — but the same envelope
  // now fails the timestamp check first, so reuse stays unreachable
  // through the verify path.
  h.advance(WEBHOOK_RETENTION_MS - 2 * WEBHOOK_TOLERANCE_SECONDS * 1000);
  const lapsed = await deliver(sha, "nonce-future-edge", futureTs);
  strictEqual(lapsed.status, 401);
  match(errorOf(lapsed), /outside tolerance window/);
});

test("webhook auth: nonce SUBSTITUTION fails the HMAC (stolen signature cannot be replayed under a fresh nonce)", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "substitute");
  const base = h.nowSeconds();

  // Sender legitimately signs nonce "nonce-orig" over commit 1.
  const sha1 = await commitRaw(h.rig, task.fork.name, "wip 1");
  strictEqual(
    (await signedWebhook(h.rig.services, {
      raw: JSON.stringify({ fork: task.fork.name, sha: sha1 }),
      nonce: "nonce-orig",
    })).status,
    200,
  );

  // Attacker captures that signature and replays it with a FRESH synthetic
  // nonce (fresh nonces always pass the replay guard — only the signature
  // binds them). The recomputed HMAC over the attacker's nonce mismatches.
  const sha2 = await commitRaw(h.rig, task.fork.name, "wip 2");
  const stolen = `sha256=${await hmacHex(SECRET, `${base}.nonce-orig.${JSON.stringify({ fork: task.fork.name, sha: sha2 })}`)}`;
  const substituted = await signedWebhook(h.rig.services, {
    raw: JSON.stringify({ fork: task.fork.name, sha: sha2 }),
    signature: stolen,
    nonce: "attacker-fresh-nonce",
  });
  strictEqual(substituted.status, 401);
  strictEqual(errorOf(substituted), "webhook signature mismatch");

  // The matching nonce replays as 409: the signature is VALID, but that
  // nonce was already consumed by the first delivery.
  const replayed = await signedWebhook(h.rig.services, {
    raw: JSON.stringify({ fork: task.fork.name, sha: sha2 }),
    signature: stolen,
    nonce: "nonce-orig",
  });
  strictEqual(replayed.status, 409);
});

test("webhook auth: nonce is required and bounded", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "nonce");
  const raw = JSON.stringify({ fork: task.fork.name, sha: await commitRaw(h.rig, task.fork.name, "wip") });
  strictEqual((await signedWebhook(h.rig.services, { raw })).status, 200); // positive first

  const missing = await signedWebhook(h.rig.services, { raw, nonce: null });
  strictEqual(missing.status, 401);
  match(errorOf(missing), /nonce/);

  const empty = await signedWebhook(h.rig.services, { raw, nonce: "" });
  strictEqual(empty.status, 401);

  const oversize = await signedWebhook(h.rig.services, { raw, nonce: "x".repeat(257) });
  strictEqual(oversize.status, 401);
  match(errorOf(oversize), /nonce/);
});

test("webhook auth: unconfigured WEBHOOK_SECRET fails closed with 503", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "nosecret");
  const raw = JSON.stringify({ fork: task.fork.name, sha: await commitRaw(h.rig, task.fork.name, "wip") });
  h.rig.services.webhookAuth = { nowMs: () => NOW_MS, replayGuard: h.guard };
  const res = await signedWebhook(h.rig.services, { raw });
  strictEqual(res.status, 503);
  match(errorOf(res), /WEBHOOK_SECRET is not configured; refusing signed webhook \(fail closed\)/);
});

test("webhook auth: unconfigured replay guard fails closed with 503", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "noguard");
  const raw = JSON.stringify({ fork: task.fork.name, sha: await commitRaw(h.rig, task.fork.name, "wip") });
  h.rig.services.webhookAuth = { secret: SECRET, nowMs: () => NOW_MS };
  const res = await signedWebhook(h.rig.services, { raw });
  strictEqual(res.status, 503);
  match(errorOf(res), /replay guard is not configured/);
});

test("webhook auth: malformed JSON with a VALID signature is 400; the nonce was consumed (verification precedes parsing)", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "malformed");
  const bad = await signedWebhook(h.rig.services, { raw: "{not json", nonce: "nonce-mal" });
  strictEqual(bad.status, 400);
  strictEqual(errorOf(bad), "request body must be valid JSON");

  // The delivery was authenticated (signature verified) before the body
  // was parsed, so its nonce is spent: a same-nonce retry is a replay.
  // Senders regenerate the nonce per delivery attempt.
  const sha = await commitRaw(h.rig, task.fork.name, "wip after garbage");
  const sameNonce = await signedWebhook(h.rig.services, {
    raw: JSON.stringify({ fork: task.fork.name, sha }),
    nonce: "nonce-mal",
  });
  strictEqual(sameNonce.status, 409); // authenticated delivery, duplicate nonce → conflict
  deepStrictEqual(sameNonce.body, { error: "conflict", message: "webhook replay detected: nonce already used" });

  const freshNonce = await signedWebhook(h.rig.services, {
    raw: JSON.stringify({ fork: task.fork.name, sha }),
    nonce: "nonce-mal-2",
  });
  strictEqual(freshNonce.status, 200);
});

test("webhook auth: adapter without rawText cannot present signed webhooks (401, fail closed)", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "noraw");
  const raw = JSON.stringify({ fork: task.fork.name, sha: await commitRaw(h.rig, task.fork.name, "wip") });
  const res = await signedWebhook(h.rig.services, { raw, withRawText: false });
  strictEqual(res.status, 401);
  match(errorOf(res), /no raw body/);
});

test("webhook auth: replay guard only records FULLY verified deliveries", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "burn");
  const base = h.nowSeconds();
  const deliver = async (message: string, nonce: string, over: Partial<Parameters<typeof signedWebhook>[1]> = {}) =>
    signedWebhook(h.rig.services, {
      raw: JSON.stringify({ fork: task.fork.name, sha: await commitRaw(h.rig, task.fork.name, message) }),
      nonce,
      ...over,
    });

  // Bad-signature and stale-timestamp deliveries must not consume nonces.
  strictEqual((await deliver("wip a", "g1", { signingSecret: "wrong" })).status, 401);
  strictEqual((await deliver("wip b", "g1")).status, 200);
  strictEqual((await deliver("wip c", "g2", { timestampHeader: String(base - 10_000) })).status, 401);
  strictEqual((await deliver("wip d", "g2")).status, 200);
});

test("webhook auth: unsigned bearer ladder is unchanged (backward compatibility)", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "compat");
  const sha = await commitRaw(h.rig, task.fork.name, "wip sidecar");

  // Anonymous still 401.
  const anon = await handleRoute(
    h.rig.services,
    neutralRequest("POST", "/events/push", { fork: task.fork.name, sha }),
  );
  strictEqual(anon.status, 401);

  // Sidecar bearer (the current sidecar contract) still accepted.
  const bearer = await handleRoute(
    h.rig.services,
    neutralRequest("POST", "/events/push", { fork: task.fork.name, ref: "refs/heads/main", sha }, "sidecar-t"),
  );
  strictEqual(bearer.status, 200);
  strictEqual((bearer.body as { accepted: boolean }).accepted, true);

  // Bearer senders that also attach webhook-style headers are NOT
  // replay-checked: replay protection binds to the signature credential
  // only (documented limitation of the bearer path).
  const sha2 = await commitRaw(h.rig, task.fork.name, "wip bearer twice");
  const headers: Record<string, string> = {
    "x-webhook-timestamp": String(h.nowSeconds() - 10_000),
    "x-webhook-nonce": "same-nonce",
  };
  const withStaleHeaders = (token: string) =>
    handleRoute(h.rig.services, {
      method: "POST",
      path: "/events/push",
      header: (name) =>
        headers[name.toLowerCase()] ?? (name.toLowerCase() === "authorization" ? `Bearer ${token}` : null),
      json: async () => ({ fork: task.fork.name, sha: sha2 }),
    });
  strictEqual((await withStaleHeaders("sidecar-t")).status, 200);
  strictEqual((await withStaleHeaders("sidecar-t")).status, 200);
});

test("webhook auth: signed envelope accepted on /events/artifacts; wrong secret 401", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "envelope");
  const envelope = (sha: string, before: string) =>
    JSON.stringify({
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: "local", repoName: task.fork.name },
      payload: { ref: "refs/heads/main", before, after: sha, commits: [], totalCommitsCount: 1, commitsTruncated: false },
      metadata: { accountId: "local", eventSubscriptionId: "t", eventSchemaVersion: 1, eventTimestamp: "2026-10-04T12:00:00.000Z" },
    });
  const beforeSha = await h.rig.git.headCommit(task.fork.name);
  const sha1 = await commitRaw(h.rig, task.fork.name, "wip envelope");
  const good = await signedWebhook(h.rig.services, {
    path: "/events/artifacts",
    raw: envelope(sha1, beforeSha ?? sha1),
    nonce: "n-env",
  });
  strictEqual(good.status, 200);
  strictEqual((good.body as { accepted: boolean }).accepted, true);

  const sha2 = await commitRaw(h.rig, task.fork.name, "wip envelope 2");
  const bad = await signedWebhook(h.rig.services, {
    path: "/events/artifacts",
    raw: envelope(sha2, sha1),
    signingSecret: "wrong-secret",
  });
  strictEqual(bad.status, 401);
});

test("webhook auth: a signature on a non-webhook route does not substitute for its bearer", async () => {
  const h = webhookRig();
  const signature = `sha256=${await hmacHex(SECRET, `${Math.floor(NOW_MS / 1000)}.n-1.${JSON.stringify({ agent: "x" })}`)}`;
  const res = await signedWebhook(h.rig.services, {
    path: "/tasks",
    raw: JSON.stringify({ agent: "x" }),
    signature,
  });
  strictEqual(res.status, 401); // /tasks still requires ADMIN_TOKEN
});

test("error redaction: unexpected internal failure returns a fixed 500 body (no message, no stack)", async () => {
  const h = webhookRig();
  const task = await createTask(h.rig, "redact");
  const sha = await commitRaw(h.rig, task.fork.name, "wip boom");
  const boom = new Error("getaddrinfo ENOTFOUND artifacts.internal:443 — /root/agent/.config/creds");
  const brokenCoordinator = new Proxy(h.rig.core, {
    get(target, prop) {
      if (prop === "recordPush") {
        return async () => {
          throw boom;
        };
      }
      return Reflect.get(target, prop);
    },
  });
  const services: RouterServices = { ...h.rig.services, coordinator: brokenCoordinator };

  const res = await handleRoute(
    services,
    neutralRequest("POST", "/events/push", { fork: task.fork.name, ref: "refs/heads/main", sha }, "admin-t"),
  );
  strictEqual(res.status, 500);
  deepStrictEqual(res.body, { error: "internal server error" });
  const text = JSON.stringify(res.body);
  for (const leak of ["ENOTFOUND", "artifacts.internal", "creds", "at ", "Error:"]) {
    ok(!text.includes(leak), `500 body must not contain ${JSON.stringify(leak)}`);
  }

  // Contrast: caller-mistake 400s keep their explicit, caller-safe text.
  const callerMistake = await signedWebhook(h.rig.services, { raw: JSON.stringify({ fork: task.fork.name }) });
  strictEqual(callerMistake.status, 400);
  strictEqual(errorOf(callerMistake), "agent or fork, and sha are required strings");
});

test("error redaction: auth failures never echo the presented bearer token", async () => {
  const h = webhookRig();
  const presented = "super-secret-bearer-attempt";
  const res = await handleRoute(
    h.rig.services,
    neutralRequest("POST", "/events/push", { fork: "whatever", sha: "deadbeef" }, presented),
  );
  strictEqual(res.status, 401);
  ok(!JSON.stringify(res.body).includes(presented));
});

test("MemoryReplayGuard: duplicate rejection, retention past the validity horizon, bounded capacity with oldest eviction", () => {
  let now = 1_000_000;
  const guard = new MemoryReplayGuard({ nowMs: () => now });
  strictEqual(guard.admit("a"), true);
  strictEqual(guard.admit("a"), false);
  strictEqual(guard.size, 1);
  // Retention is strictly beyond 2×tolerance (C1506): at exactly the end
  // of a max-future envelope's validity the nonce must still be held.
  now += 2 * WEBHOOK_TOLERANCE_SECONDS * 1000;
  strictEqual(guard.admit("a"), false);
  now += WEBHOOK_RETENTION_MS - 2 * WEBHOOK_TOLERANCE_SECONDS * 1000;
  strictEqual(guard.admit("a"), true); // retention lapsed → re-admitted, no unbounded growth

  const tiny = new MemoryReplayGuard({ nowMs: () => now, maxEntries: 2 });
  strictEqual(tiny.admit("x"), true);
  strictEqual(tiny.admit("y"), true);
  strictEqual(tiny.admit("z"), true); // capacity: evicts x
  strictEqual(tiny.size, 2);
  strictEqual(tiny.admit("z"), false); // still resident
  strictEqual(tiny.admit("x"), true); // was evicted
  strictEqual(tiny.admit("y"), true); // evicted when x re-entered
  strictEqual(tiny.size, 2);
});
