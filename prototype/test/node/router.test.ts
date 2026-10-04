/**
 * Wire parity of the provider-neutral router under plain node --test
 * (facade extraction, 2026-10-03): same statuses, error bodies and auth
 * decisions as the CONTRACT (0.1.x) — produced by handleRoute without any
 * HTTP platform, exercised here over neutral request objects.
 */

import { test } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { handleRoute } from "../../src/core/router.js";
import { makeRig, neutralRequest, rejectionMessage, type TestRig } from "./fakes.js";

async function call(rig: TestRig, method: string, path: string, body?: unknown, token?: string) {
  return handleRoute(rig.services, neutralRequest(method, path, body, token));
}

test("routing: unknown routes and unauthenticated setup", async () => {
  const rig = makeRig();
  const missing = await call(rig, "GET", "/definitely/not/a/route");
  strictEqual(missing.status, 404);
  deepStrictEqual(missing.body, { error: "no route for GET /definitely/not/a/route" });

  const anon = await call(rig, "POST", "/setup", {});
  strictEqual(anon.status, 401);

  const wrong = await call(rig, "POST", "/setup", {}, "not-the-admin");
  strictEqual(wrong.status, 401);
  deepStrictEqual(wrong.body, { error: "unauthorized: valid bearer token required (ADMIN_TOKEN)" });

  const ok_ = await call(rig, "POST", "/setup", {}, "admin-t");
  strictEqual(ok_.status, 201);
});

test("fail-closed: unconfigured admin token refuses authenticated routes", async () => {
  const rig = makeRig({});
  const denied = await call(rig, "POST", "/setup", {}, "anything");
  strictEqual(denied.status, 503);
  ok((denied.body as { error: string }).error.includes("not configured; refusing authenticated request"));
});

test("/tasks and /status over the neutral router", async () => {
  const rig = makeRig();
  const anon = await call(rig, "POST", "/tasks", { agent: "x" });
  strictEqual(anon.status, 401);

  const created = await call(rig, "POST", "/tasks", { agent: "via-router", intent: "router" }, "admin-t");
  strictEqual(created.status, 201);
  const task = created.body as { taskId: string; agentId: string; intent: string | null };
  strictEqual(task.agentId, "via-router-0001");
  strictEqual(task.intent, "router");

  const status = await call(rig, "GET", "/status", undefined, "admin-t");
  strictEqual(status.status, 200);
  ok((status.body as { agents: unknown[] }).agents.length === 1);
});

test("/events/push: validation, auth ladder, cross-agent 403, dedup", async () => {
  const rig = makeRig();
  const created = (await call(rig, "POST", "/tasks", { agent: "eve" }, "admin-t")).body as {
    agentId: string;
    fork: { name: string };
    token: { plaintext: string };
  };
  const other = (await call(rig, "POST", "/tasks", { agent: "malory" }, "admin-t")).body as {
    agentId: string;
    token: { plaintext: string };
  };
  const sha = rig.git.commit(created.fork.name, "wip: via route");

  // Malformed body: no sha.
  const bad = await call(rig, "POST", "/events/push", { agent: created.agentId }, "admin-t");
  strictEqual(bad.status, 400);
  deepStrictEqual(bad.body, { error: "agent or fork, and sha are required strings" });

  // Anonymous push rejected.
  strictEqual((await call(rig, "POST", "/events/push", { agent: created.agentId, sha })).status, 401);

  // Another agent's token is 403, with neither token echoed.
  const cross = await call(rig, "POST", "/events/push", { agent: created.agentId, sha }, other.token.plaintext);
  strictEqual(cross.status, 403);
  deepStrictEqual(cross.body, { error: `forbidden: this token belongs to ${other.agentId}, not ${created.agentId}` });

  // Own token accepted.
  const own = await call(rig, "POST", "/events/push", { agent: created.agentId, sha }, created.token.plaintext);
  strictEqual(own.status, 200);
  strictEqual((own.body as { accepted: boolean }).accepted, true);

  // Sidecar webhook shape: fork identifies the pusher, sidecar bearer accepted.
  const sha2 = rig.git.commit(created.fork.name, "wip: webhook");
  const hook = await call(
    rig,
    "POST",
    "/events/push",
    { fork: created.fork.name, ref: "refs/heads/main", sha: sha2 },
    "sidecar-t",
  );
  strictEqual(hook.status, 200);
  strictEqual((hook.body as { agent: string }).agent, created.agentId);

  // Redelivery dedupes.
  const redelivery = await call(rig, "POST", "/events/push", { agent: created.agentId, sha: sha2 }, "admin-t");
  strictEqual((redelivery.body as { deduped: boolean }).deduped, true);
});

test("/events/artifacts: envelope accepted, unknown fork 202, bad envelope 400", async () => {
  const rig = makeRig();
  const created = (await call(rig, "POST", "/tasks", { agent: "env" }, "admin-t")).body as {
    agentId: string;
    fork: { name: string };
    head: string | null;
  };
  const sha = rig.git.commit(created.fork.name, "wip: envelope");
  const envelope = {
    type: "cf.artifacts.repo.pushed",
    source: { type: "artifacts.repo", namespace: "local", repoName: created.fork.name },
    payload: { ref: "refs/heads/main", before: created.head, after: sha, commits: [], totalCommitsCount: 1, commitsTruncated: false },
    metadata: { accountId: "local", eventSubscriptionId: "t", eventSchemaVersion: 1, eventTimestamp: "2026-10-03T12:00:00.000Z" },
  };

  const anon = await call(rig, "POST", "/events/artifacts", envelope);
  strictEqual(anon.status, 401);

  const accepted = await call(rig, "POST", "/events/artifacts", envelope, "sidecar-t");
  strictEqual(accepted.status, 200);
  strictEqual((accepted.body as { heads: Record<string, string> }).heads[created.agentId], sha);

  const stranger = await call(
    rig,
    "POST",
    "/events/artifacts",
    { ...envelope, source: { type: "artifacts.repo", namespace: "local", repoName: "who-knows" } },
    "sidecar-t",
  );
  strictEqual(stranger.status, 202);
  deepStrictEqual(stranger.body, { accepted: false, reason: "no agent owns fork who-knows" });

  const malformed = await call(
    rig,
    "POST",
    "/events/artifacts",
    { type: "something.else" },
    "sidecar-t",
  );
  strictEqual(malformed.status, 400);
  ok((malformed.body as { error: string }).error.includes("unsupported event type"));
});

test("/checks: runner auth, parse errors, stale 409, success shape", async () => {
  const rig = makeRig();
  const a = (await call(rig, "POST", "/tasks", { agent: "a" }, "admin-t")).body as { agentId: string; fork: { name: string } };
  const b = (await call(rig, "POST", "/tasks", { agent: "b" }, "admin-t")).body as { agentId: string };
  const vector = ((await call(rig, "GET", "/status", undefined, "runner-t")).body as { heads: Record<string, string> }).heads;

  strictEqual((await call(rig, "POST", "/checks", { contract: "0.0", vector, policy: "p", results: [] })).status, 401);
  strictEqual((await call(rig, "POST", "/checks", { contract: "0.0", vector, policy: "p", results: [] }, "admin-t")).status, 401,
    "admin is not the runner");
  strictEqual(
    (await call(rig, "POST", "/checks", { vector, policy: "p", results: [] }, "runner-t")).status,
    400,
    "missing contract declaration",
  );

  const stale = await call(
    rig,
    "POST",
    "/checks",
    {
      contract: "0.0",
      vector: { ...vector, [a.agentId]: "0".repeat(40) },
      policy: "p",
      results: [{ pair: [a.agentId, b.agentId], status: "clean" }],
    },
    "runner-t",
  );
  strictEqual(stale.status, 409);
  ok((stale.body as { error: string }).error.startsWith("stale vector:"));
  deepStrictEqual((stale.body as { currentHeads: Record<string, string> }).currentHeads, vector);

  const good = await call(
    rig,
    "POST",
    "/checks",
    {
      contract: "0.0",
      vector,
      policy: "runner-policy",
      results: [{ pair: [a.agentId, b.agentId], status: "conflict", kind: "merge-conflict" }],
    },
    "runner-t",
  );
  strictEqual(good.status, 200);
  const body = good.body as { accepted: number; createdWarnings: { id: string }[]; pairs: { status: string }[] };
  strictEqual(body.accepted, 1);
  strictEqual(body.createdWarnings.length, 1);
  ok(body.pairs[0].status === "conflict");
});

test("/tasks/:id and /tasks/:id/tests: 404s and owner-only provenance", async () => {
  const rig = makeRig();
  const created = (await call(rig, "POST", "/tasks", { agent: "own" }, "admin-t")).body as {
    taskId: string;
    agentId: string;
    fork: { name: string };
    token: { plaintext: string };
  };
  const stranger = (await call(rig, "POST", "/tasks", { agent: "str" }, "admin-t")).body as {
    agentId: string;
    token: { plaintext: string };
  };

  const found = await call(rig, "GET", `/tasks/${created.taskId}`, undefined, created.token.plaintext);
  strictEqual(found.status, 200);
  strictEqual((found.body as { agentId: string }).agentId, created.agentId);
  const missing = await call(rig, "GET", "/tasks/task-9999", undefined, "admin-t");
  strictEqual(missing.status, 404);
  ok((missing.body as { error: string }).error.startsWith("unknown task"));

  const sha = rig.git.commit(created.fork.name, "wip: provenance");
  const anon = await call(rig, "POST", `/tasks/${created.taskId}/tests`, { command: "npm test", exit: 0, head_sha: sha });
  strictEqual(anon.status, 401);
  const cross = await call(
    rig, "POST", `/tasks/${created.taskId}/tests`,
    { command: "npm test", exit: 0, head_sha: sha },
    stranger.token.plaintext,
  );
  strictEqual(cross.status, 403);
  const badShape = await call(
    rig, "POST", `/tasks/${created.taskId}/tests`, { command: "npm test" }, created.token.plaintext,
  );
  strictEqual(badShape.status, 400);
  const good = await call(
    rig, "POST", `/tasks/${created.taskId}/tests`,
    { command: "npm test", exit: 0, head_sha: sha },
    created.token.plaintext,
  );
  strictEqual(good.status, 201);
  const unknownTask = await call(
    rig, "POST", "/tasks/task-9999/tests", { command: "npm test", exit: 0, head_sha: sha }, "admin-t",
  );
  strictEqual(unknownTask.status, 404);
});

test("/warnings/:id/ack: body validated before auth, owner-only acks", async () => {
  const rig = makeRig();
  const a = (await call(rig, "POST", "/tasks", { agent: "a" }, "admin-t")).body as {
    agentId: string; token: { plaintext: string };
  };
  const b = (await call(rig, "POST", "/tasks", { agent: "b" }, "admin-t")).body as {
    agentId: string; token: { plaintext: string };
  };
  const vector = ((await call(rig, "GET", "/status", undefined, "admin-t")).body as { heads: Record<string, string> }).heads;
  const warningId = ((await call(
    rig, "POST", "/checks",
    { contract: "0.0", vector, policy: "p", results: [{ pair: [a.agentId, b.agentId], status: "conflict" }] },
    "runner-t",
  )).body as { createdWarnings: { id: string }[] }).createdWarnings[0].id;

  const noAgent = await call(rig, "POST", `/warnings/${warningId}/ack`, {}, "admin-t");
  strictEqual(noAgent.status, 400);
  deepStrictEqual(noAgent.body, { error: "agent is a required string" });

  const cross = await call(rig, "POST", `/warnings/${warningId}/ack`, { agent: a.agentId }, b.token.plaintext);
  strictEqual(cross.status, 403);

  const ok_ = await call(rig, "POST", `/warnings/${warningId}/ack`, { agent: a.agentId, note: "seen" }, a.token.plaintext);
  strictEqual(ok_.status, 200);
  strictEqual(((ok_.body as { warning: { acks: { note?: string }[] } }).warning.acks[0])?.note, "seen");

  const unknown = await call(rig, "POST", "/warnings/warn-9999/ack", { agent: a.agentId }, "admin-t");
  strictEqual(unknown.status, 404);
});

test("malformed JSON bodies map to the contract 400", async () => {
  const rig = makeRig();
  const response = await handleRoute(rig.services, {
    method: "POST",
    path: "/tasks",
    header: () => "Bearer admin-t",
    json: async () => {
      throw new SyntaxError("unexpected token");
    },
  });
  strictEqual(response.status, 400);
  deepStrictEqual(response.body, { error: "request body must be valid JSON" });
});

/**
 * C1462 Task 1: read endpoints require a bearer. Negatives 1-5 and
 * positives 1-2 below are the mandated matrix; the extras pin the rest of
 * the ladder (admin/runner reads, cross-agent 403, expired/revoked task
 * reads, auth-before-404) so the gate cannot quietly narrow later.
 */
test("read auth: GET /status and GET /tasks/:id require a valid bearer (C1462 Task 1)", async () => {
  const rig = makeRig();
  const created = (await call(rig, "POST", "/tasks", { agent: "reader" }, "admin-t")).body as {
    taskId: string;
    agentId: string;
    token: { plaintext: string };
  };

  // Negative 1: no Authorization header at all.
  const noHeader = await call(rig, "GET", "/status");
  strictEqual(noHeader.status, 401);
  deepStrictEqual(noHeader.body, { error: "unauthorized", message: "Missing or invalid bearer token" });

  // Negative 2: malformed bearer headers (wrong scheme, bare "Bearer",
  // whitespace token) are indistinguishable from anonymous.
  for (const header of ["Basic dXNlcjpwYXNz", "Bearer", "Bearer   "]) {
    const malformed = await handleRoute(rig.services, {
      method: "GET",
      path: "/status",
      header: (name) => (name.toLowerCase() === "authorization" ? header : null),
      json: async () => {
        throw new Error("no body");
      },
    });
    strictEqual(malformed.status, 401, `malformed header ${JSON.stringify(header)} must deny`);
    deepStrictEqual(malformed.body, { error: "unauthorized", message: "Missing or invalid bearer token" });
  }

  // Negative 3: already-expired task token (negative TTL at mint).
  const expired = (await call(rig, "POST", "/tasks", { agent: "gone", ttlSeconds: -1 }, "admin-t")).body as {
    taskId: string;
    token: { plaintext: string; expiresAt: string };
  };
  ok(Date.parse(expired.token.expiresAt) <= Date.now(), "fixture token must already be expired");
  const expiredStatus = await call(rig, "GET", "/status", undefined, expired.token.plaintext);
  strictEqual(expiredStatus.status, 401);
  deepStrictEqual(expiredStatus.body, { error: "unauthorized", message: "Missing or invalid bearer token" });

  // Negative 4: revoked task token — revoked through the admin route.
  const revocable = (await call(rig, "POST", "/tasks", { agent: "revoked" }, "admin-t")).body as {
    taskId: string;
    token: { plaintext: string };
  };
  const revokeAck = await call(rig, "POST", `/tasks/${revocable.taskId}/revoke`, undefined, "admin-t");
  strictEqual(revokeAck.status, 200);
  const revokedStatus = await call(rig, "GET", "/status", undefined, revocable.token.plaintext);
  strictEqual(revokedStatus.status, 401);
  deepStrictEqual(revokedStatus.body, { error: "unauthorized", message: "Missing or invalid bearer token" });

  // Positive 1: valid active agent token (also admin, also runner) reads /status.
  const agentStatus = await call(rig, "GET", "/status", undefined, created.token.plaintext);
  strictEqual(agentStatus.status, 200);
  ok((agentStatus.body as { agents: unknown[] }).agents.length >= 1);
  strictEqual((await call(rig, "GET", "/status", undefined, "admin-t")).status, 200);
  strictEqual((await call(rig, "GET", "/status", undefined, "runner-t")).status, 200, "runner fetches the heads vector");

  // Negative 5: task reads reject anonymous callers too.
  const anonTask = await call(rig, "GET", `/tasks/${created.taskId}`);
  strictEqual(anonTask.status, 401);
  deepStrictEqual(anonTask.body, { error: "unauthorized", message: "Missing or invalid bearer token" });

  // Positive 2: the owning agent's token (and admin) read the task.
  const ownTask = await call(rig, "GET", `/tasks/${created.taskId}`, undefined, created.token.plaintext);
  strictEqual(ownTask.status, 200);
  strictEqual((ownTask.body as { agentId: string }).agentId, created.agentId);
  strictEqual((await call(rig, "GET", `/tasks/${created.taskId}`, undefined, "admin-t")).status, 200);

  // Ladder extras.
  const stranger = (await call(rig, "POST", "/tasks", { agent: "stranger" }, "admin-t")).body as {
    token: { plaintext: string };
  };
  strictEqual(
    (await call(rig, "GET", `/tasks/${created.taskId}`, undefined, stranger.token.plaintext)).status,
    403,
    "valid foreign token is 403, not 401",
  );
  strictEqual((await call(rig, "GET", `/tasks/${created.taskId}`, undefined, "runner-t")).status, 401);
  strictEqual((await call(rig, "GET", `/tasks/${expired.taskId}`, undefined, expired.token.plaintext)).status, 401);
  strictEqual((await call(rig, "GET", `/tasks/${revocable.taskId}`, undefined, revocable.token.plaintext)).status, 401);
  strictEqual((await call(rig, "GET", "/tasks/task-9999", undefined, created.token.plaintext)).status, 404);
  strictEqual((await call(rig, "GET", "/tasks/task-9999")).status, 401, "anonymous callers cannot probe task ids");
});

test("rejectionMessage helper stays honest (guards the suite itself)", async () => {
  const rig = makeRig();
  await rejectionMessage(rig.core.getTask("task-9999"), /^unknown task:/);
});
