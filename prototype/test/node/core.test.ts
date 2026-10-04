/**
 * CoordinatorCore business rules under plain node --test (facade extraction,
 * 2026-10-03): task registry, head vectors, dedup + ring, warnings,
 * checks validation, the stale-vector rule — all against in-memory fakes,
 * NO workerd and NO Cloudflare.
 */

import { test } from "node:test";
import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { parseChecksPayload } from "../../src/checks-wire.js";
import { StubRadar } from "../../src/radar.js";
import { sha256Hex } from "../../src/core/auth.js";
import { CoordinatorCore } from "../../src/core/coordinator.js";
import type { CoordinatorModel } from "../../src/core/model.js";
import { FileCoordinationStore, MemoryCoordinationStore } from "../../src/local/store.js";
import { fakeClock, fixedIds, makeRig, rejectionMessage } from "./fakes.js";

test("setup creates the canonical repo once (idempotent)", async () => {
  const rig = makeRig();
  const first = await rig.core.setup();
  strictEqual(first.created, true);
  match(first.canonical.name, /^agent-branches-canonical-cafe1234$/);
  ok(first.seedCommit, "seed commit expected from the fake host");
  const again = await rig.core.setup();
  strictEqual(again.created, false);
  strictEqual(again.canonical.name, first.canonical.name);
  strictEqual(again.seedCommit, null);
});

test("createTask forks canonical, mints a token and records the head", async () => {
  const rig = makeRig();
  const alpha = await rig.core.createTask({ agent: "Alpha", intent: "work" });
  strictEqual(alpha.agentId, "alpha-0001");
  strictEqual(alpha.taskId, "task-0001");
  match(alpha.fork.name, /-alpha-0001$/);
  strictEqual(alpha.token.scope, "write");
  ok(/^[0-9a-f]{40}$/.test(alpha.head ?? ""), "head must be the fork tip");
  strictEqual(alpha.base_sha, alpha.head, "fake fork realizes the canonical tip exactly");
  strictEqual(alpha.intent, "work");

  const beta = await rig.core.createTask({ agent: "beta" });
  strictEqual(beta.agentId, "beta-0002");
  strictEqual(beta.head, alpha.head, "siblings start at the same base");

  // The token digest is stored, the plaintext is not.
  const owner = await rig.core.credentialAgent(alpha.token.plaintext);
  strictEqual(owner, "alpha-0001");
  strictEqual(await rig.core.credentialAgent("garbage"), null);
});

test("createTask validates base_sha (40-hex, must exist in canonical history)", async () => {
  const rig = makeRig();
  await rig.core.setup();
  await rejectionMessage(rig.core.createTask({ agent: "x", baseSha: "nothex" }), /base_sha must be a 40-hex/);
  await rejectionMessage(rig.core.createTask({ agent: "x", baseSha: "f".repeat(40) }), /not found in canonical history/);
});

test("recordPush accepts real commits, resolves fork owners, rejects lies", async () => {
  const rig = makeRig();
  const created = await rig.core.createTask({ agent: "pusher" });
  await rig.core.createTask({ agent: "peer" });
  const sha = rig.git.commit(created.fork.name, "wip: real work");

  const accepted = await rig.core.recordPush({ agent: created.agentId, sha });
  strictEqual(accepted.accepted, true);
  strictEqual(accepted.deduped, false);
  strictEqual(accepted.heads[created.agentId], sha);
  ok(accepted.radarChecks >= 1, "stub radar logs sibling pairs");

  // Webhook shape: fork only, no agent id.
  const viaFork = await rig.core.recordPush({ fork: created.fork.name, sha: rig.git.commit(created.fork.name, "wip: 2") });
  strictEqual(viaFork.agent, created.agentId);

  // Unknown agent / wrong fork / unknown commit.
  await rejectionMessage(rig.core.recordPush({ agent: "ghost-9999", sha }), /^unknown agent:/);
  await rejectionMessage(
    rig.core.recordPush({ agent: created.agentId, fork: "somebody-elses", sha }),
    /does not belong to agent/,
  );
  await rejectionMessage(rig.core.recordPush({ agent: created.agentId, sha: "a".repeat(40) }), /not found in/);
});

test("push dedup: exact redelivery and the bounded per-agent ring", async () => {
  const rig = makeRig();
  const created = await rig.core.createTask({ agent: "dedup" });
  const sha = rig.git.commit(created.fork.name, "wip: once");
  await rig.core.recordPush({ agent: created.agentId, sha });
  const again = await rig.core.recordPush({ agent: created.agentId, sha });
  strictEqual(again.deduped, true);
  strictEqual(again.radarChecks, 0);

  const shas: string[] = [];
  for (let i = 0; i < 18; i++) {
    shas.push(rig.git.commit(created.fork.name, `wip: ring ${i}`));
  }
  for (const ring of shas) {
    const result = await rig.core.recordPush({ agent: created.agentId, sha: ring });
    strictEqual(result.deduped, false);
  }
  const inRing = await rig.core.recordPush({ agent: created.agentId, sha: shas[shas.length - 2] });
  strictEqual(inRing.deduped, true, "still inside the 16-entry window");
  const evicted = await rig.core.recordPush({ agent: created.agentId, sha: shas[0] });
  strictEqual(evicted.deduped, false, "oldest entries leave the bounded window");
});

test("stale-vector rule: submitChecks rejects results at old heads", async () => {
  const rig = makeRig();
  const a = await rig.core.createTask({ agent: "a" });
  const b = await rig.core.createTask({ agent: "b" });
  const fresh = (await rig.core.status()).heads;

  const sha = rig.git.commit(a.fork.name, "wip: heads moved");
  await rig.core.recordPush({ agent: a.agentId, sha });

  const outcome = await rig.core.submitChecks(
    parseChecksPayload({
      contract: "0.0",
      vector: fresh,
      policy: "p",
      results: [{ pair: [a.agentId, b.agentId], status: "conflict" }],
    }),
  );
  deepStrictEqual(outcome, { stale: true, currentHeads: (await rig.core.status()).heads });
});

test("checks validation: statuses, pairs, duplicate conflicts and clean resolution", async () => {
  const rig = makeRig();
  const a = await rig.core.createTask({ agent: "a" });
  const b = await rig.core.createTask({ agent: "b" });
  const vector = (await rig.core.status()).heads;
  const base = { contract: "0.0", vector, policy: "test-policy" } as const;

  // not_checked is never a runner result; invalid statuses rejected.
  await rejectionMessage(
    rig.core.submitChecks(parseChecksPayload({ ...base, results: [{ pair: [a.agentId, b.agentId], status: "not_checked" }] })),
    /runner results must be/,
  );
  await rejectionMessage(
    rig.core.submitChecks(parseChecksPayload({ ...base, results: [{ pair: [a.agentId, "ghost-9999"], status: "conflict" }] })),
    /unknown agent in pair/,
  );

  // A conflict at the current vector creates exactly ONE warning.
  const first = (await rig.core.submitChecks(
    parseChecksPayload({ ...base, results: [{ pair: [a.agentId, b.agentId], status: "conflict", kind: "merge-conflict" }] }),
  )) as { stale: false; createdWarnings: { id: string; pair: [string, string] }[] };
  strictEqual(first.createdWarnings.length, 1);
  const warningId = first.createdWarnings[0].id;

  // Reversed pair at the same heads: deduplicated, no second warning.
  const reversed = (await rig.core.submitChecks(
    parseChecksPayload({ ...base, results: [{ pair: [b.agentId, a.agentId], status: "conflict", kind: "merge-conflict" }] }),
  )) as { stale: false; createdWarnings: unknown[] };
  strictEqual(reversed.createdWarnings.length, 0);

  // A later clean result at the SAME vector resolves the warning.
  const clean = (await rig.core.submitChecks(
    parseChecksPayload({ ...base, results: [{ pair: [a.agentId, b.agentId], status: "clean" }] }),
  )) as { stale: false; createdWarnings: unknown[] };
  strictEqual(clean.createdWarnings.length, 0);
  const status = await rig.core.status();
  strictEqual(status.warnings.find((warning) => warning.id === warningId)?.status, "invalidated");
  ok(status.warnings.find((warning) => warning.id === warningId)?.resolvedBy?.includes("test-policy"));
});

test("warnings: invalidation on head moves, acks record agent + head", async () => {
  const rig = makeRig();
  const a = await rig.core.createTask({ agent: "a" });
  const b = await rig.core.createTask({ agent: "b" });
  const vector = (await rig.core.status()).heads;
  const created = (await rig.core.submitChecks(
    parseChecksPayload({
      contract: "0.0",
      vector,
      policy: "p",
      results: [{ pair: [a.agentId, b.agentId], status: "conflict", kind: "merge-conflict" }],
    }),
  )) as { stale: false; createdWarnings: { id: string }[] };
  const warningId = created.createdWarnings[0].id;

  const acked = await rig.core.ackWarning(warningId, { agent: a.agentId, note: "coordinating" });
  strictEqual(acked.warning.acks[0]?.agent, a.agentId);
  strictEqual(acked.warning.acks[0]?.head, vector[a.agentId]);
  strictEqual(acked.warning.acks[0]?.note, "coordinating");

  // A new push by either pair member invalidates the active warning.
  await rig.core.recordPush({ agent: b.agentId, sha: rig.git.commit(b.fork.name, "wip: b moves") });
  const status = await rig.core.status();
  strictEqual(status.warnings.find((warning) => warning.id === warningId)?.status, "invalidated");

  await rejectionMessage(rig.core.ackWarning(warningId, { agent: "ghost-9999" }), /^unknown agent:/);
  await rejectionMessage(rig.core.ackWarning("warn-9999", { agent: a.agentId }), /^unknown warning:/);
});

test("test provenance: validated, commit-verified, attached to the task", async () => {
  const rig = makeRig();
  const created = await rig.core.createTask({ agent: "tester" });
  const sha = rig.git.commit(created.fork.name, "wip: tested");

  const result = await rig.core.recordTestProvenance(created.taskId, {
    command: "npm test",
    exit: 0,
    head_sha: sha,
  });
  strictEqual(result.testProvenance.command, "npm test");
  strictEqual(result.testProvenance.head_sha, sha);

  const detail = await rig.core.getTask(created.taskId);
  strictEqual(detail.pushes, 0, "provenance does not count as a push");
  strictEqual(detail.testProvenance?.head_sha, sha);
  strictEqual(detail.base_sha, detail.baseSha);

  for (const bad of [
    { command: "", exit: 0, head_sha: sha },
    { command: "npm test", exit: 1.5, head_sha: sha },
    { command: "npm test", exit: 0, head_sha: "nope" },
    { command: "npm test", exit: 0, head_sha: "b".repeat(40) },
  ]) {
    await rejectionMessage(rig.core.recordTestProvenance(created.taskId, bad), /^(test provenance|commit )/);
  }
});

test("/status pair views: fresh, stale, and unprocessed-push suppression", async () => {
  const rig = makeRig();
  const a = await rig.core.createTask({ agent: "a" });
  const b = await rig.core.createTask({ agent: "b" });
  const vector = (await rig.core.status()).heads;
  await rig.core.submitChecks(parseChecksPayload({
    contract: "0.0",
    vector,
    policy: "p",
    results: [{ pair: [a.agentId, b.agentId], status: "clean" }],
  }));
  let pairs = (await rig.core.status()).pairs;
  strictEqual(pairs.length, 1);
  strictEqual(pairs[0].status, "clean");
  strictEqual(pairs[0].stale, false);

  // Heads move: the stored check is now stale => not_checked.
  await rig.core.recordPush({ agent: a.agentId, sha: rig.git.commit(a.fork.name, "wip: move") });
  pairs = (await rig.core.status()).pairs;
  strictEqual(pairs[0].status, "not_checked");
  strictEqual(pairs[0].stale, true);

  // An unprocessed push on a member suppresses even fresh results.
  rig.git.unprocessed = [
    {
      repo: b.fork.name,
      ref: "refs/heads/main",
      sha: rig.git.commit(b.fork.name, "wip: lost callback"),
      before: vector[b.agentId],
      attempts: 4,
      firstAt: "2026-10-03T12:30:00.000Z",
      lastAt: "2026-10-03T12:31:00.000Z",
      lastError: "worker returned 401",
    },
  ];
  const suppressed = await rig.core.status();
  const pair = suppressed.pairs[0];
  strictEqual(pair.status, "not_checked");
  ok(pair.unprocessedReason?.includes("unprocessed push"));
  strictEqual(suppressed.unprocessedPushes[0]?.agentId, b.agentId);
});

test("state survives a restart through the shared CoordinationStore", async () => {
  const rig = makeRig();
  const created = await rig.core.createTask({ agent: "persist", intent: "survive" });
  await rig.core.recordPush({ agent: created.agentId, sha: rig.git.commit(created.fork.name, "wip: keep me") });
  const before = await rig.core.status();

  // A SECOND core over the SAME store and git reconstructs the state.
  const second = new CoordinatorCore({
    store: rig.store,
    git: rig.git,
    radar: new StubRadar(),
    clock: fakeClock(),
    ids: fixedIds,
  });
  const after = await second.status();
  deepStrictEqual(after.heads, before.heads);
  const detail = await second.getTask(created.taskId);
  strictEqual(detail.intent, "survive");
  strictEqual(detail.pushes, 1);
  const push = await second.recordPush({ agent: created.agentId, sha: rig.git.commit(created.fork.name, "wip: after restart") });
  strictEqual(push.accepted, true);
});

test("FileCoordinationStore round-trips the model atomically", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const dir = await mkdtemp("zc-facade-test-");
  try {
    const path = `${dir}/nested/state.json`;
    const store = new FileCoordinationStore(path);
    interface Probe { value: number }
    strictEqual(await store.get<Probe>("nothing"), undefined);
    await store.put("model", { value: 41 } satisfies Probe);
    await store.put("model", { value: 42 } satisfies Probe);

    // A fresh store instance reads the persisted state (restart parity).
    const reopened = new FileCoordinationStore(path);
    deepStrictEqual(await reopened.get<Probe>("model"), { value: 42 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent mutations are serialized (no lost updates)", async () => {
  const rig = makeRig();
  const results = await Promise.all([
    rig.core.createTask({ agent: "racer", intent: "a" }),
    rig.core.createTask({ agent: "racer", intent: "b" }),
    rig.core.createTask({ agent: "racer", intent: "c" }),
  ]);
  const ids = new Set(results.map((result) => result.agentId));
  const tasks = new Set(results.map((result) => result.taskId));
  strictEqual(ids.size, 3, "distinct agents");
  strictEqual(tasks.size, 3, "distinct tasks");
  const seqs = results.map((result) => Number(result.agentId.split("-")[1])).sort((x, y) => x - y);
  deepStrictEqual(seqs, [1, 2, 3], "seq allocated without races");
  const status = await rig.core.status();
  strictEqual(status.agents.length, 3);
});

test("agent token gate: expiry boundary, fail-closed garbage expiry, revocation (C-1422/C-1425)", async () => {
  const rig = makeRig();
  const created = await rig.core.createTask({ agent: "gated" });
  const token = created.token.plaintext;
  const expiresMs = Date.parse(created.token.expiresAt);
  ok(Number.isFinite(expiresMs), "fake host mints a parseable expiresAt");

  // Exact boundary: denied AT the expiry instant (C-1430), valid one ms before.
  strictEqual(await rig.core.credentialAgent(token, expiresMs), null);
  strictEqual(await rig.core.credentialAgent(token, expiresMs + 1), null);
  strictEqual(await rig.core.credentialAgent(token, expiresMs - 60_000), created.agentId);

  // A stored expiry the parser cannot read fails CLOSED (deny, not override).
  const stored = await rig.store.get<CoordinatorModel>("model");
  ok(stored, "model expected after createTask");
  stored.agentTokens[created.agentId].expiresAt = "not-a-timestamp";
  await rig.store.put("model", stored);
  const reopened = new CoordinatorCore({
    store: rig.store,
    git: rig.git,
    radar: new StubRadar(),
    clock: fakeClock(),
    ids: fixedIds,
  });
  strictEqual(await reopened.credentialAgent(token), null);
  delete (stored.agentTokens[created.agentId] as { expiresAt?: string }).expiresAt;
  await rig.store.put("model", stored);
  const reopened2 = new CoordinatorCore({
    store: rig.store,
    git: rig.git,
    radar: new StubRadar(),
    clock: fakeClock(),
    ids: fixedIds,
  });
  strictEqual(await reopened2.credentialAgent(token), null, "missing expiresAt denies");

  // ANY non-null revokedAt marker denies, including the empty string (C-1430, C-1437).
  const revokedEmpty = await rig.store.get<CoordinatorModel>("model");
  ok(revokedEmpty, "model expected for empty-string revocation");
  // Restore known valid future expiresAt and prove the token is accepted FIRST
  // (guards against vacuous passes where missing/garbage expiry caused the deny, C-1437).
  revokedEmpty.agentTokens[created.agentId].expiresAt = new Date(Date.now() + 3600_000).toISOString();
  revokedEmpty.agentTokens[created.agentId].revokedAt = null;
  await rig.store.put("model", revokedEmpty);
  const validCheck = new CoordinatorCore({
    store: rig.store,
    git: rig.git,
    radar: new StubRadar(),
    clock: fakeClock(),
    ids: fixedIds,
  });
  strictEqual(await validCheck.credentialAgent(token), created.agentId, "valid future token accepted before revocation");

  // Now set revokedAt to empty string: must strictly deny even though unexpired and valid.
  revokedEmpty.agentTokens[created.agentId].revokedAt = "";
  await rig.store.put("model", revokedEmpty);
  const reopened3 = new CoordinatorCore({
    store: rig.store,
    git: rig.git,
    radar: new StubRadar(),
    clock: fakeClock(),
    ids: fixedIds,
  });
  strictEqual(await reopened3.credentialAgent(token), null, "empty-string revokedAt denies unexpired token");

  // Revocation denies the SAME plaintext and is idempotent; unknown agents are false.
  const rev = makeRig();
  const agent = await rev.core.createTask({ agent: "revoker" });
  strictEqual(await rev.core.revokeAgentToken(agent.agentId), true);
  strictEqual(await rev.core.credentialAgent(agent.token.plaintext), null);
  strictEqual(await rev.core.revokeAgentToken(agent.agentId), true, "re-revoke is idempotent");
  strictEqual(await rev.core.revokeAgentToken("ghost-9999"), false);
});

test("legacy hash-only state migrates to an already-expired record — no silent grace (C-1422/C-1430)", async () => {
  const rig = makeRig();
  await rig.core.setup();
  // Pre-0.1.2 stored shape: digest map only, no structured records.
  const legacy = await rig.store.get<CoordinatorModel>("model");
  ok(legacy, "model expected after setup");
  delete (legacy as Partial<CoordinatorModel>).agentTokens;
  legacy.agentTokenHashes["legacy-0001"] = await sha256Hex("legacy-token-plaintext");
  await rig.store.put("model", legacy);

  // A fresh core migrates at load: the legacy credential is materialized as
  // an ALREADY-EXPIRED record and DENIED — its mint time is unknown, so it
  // earns no silent grace (C-1430). Reissue is an explicit createTask.
  const migrated = new CoordinatorCore({
    store: rig.store,
    git: rig.git,
    radar: new StubRadar(),
    clock: fakeClock(),
    ids: fixedIds,
  });
  strictEqual(await migrated.credentialAgent("legacy-token-plaintext"), null, "legacy credential denied");

  const migratedModel = await rig.store.get<CoordinatorModel>("model");
  ok(migratedModel, "model expected");
  const record = migratedModel.agentTokens["legacy-0001"];
  ok(record, "migration must materialize the structured record");
  strictEqual(record.hash, legacy.agentTokenHashes["legacy-0001"]);
  strictEqual(record.expiresAt, "1970-01-01T00:00:00.000Z", "legacy record is already expired");
  strictEqual(record.revokedAt, null);

  // Migration is deterministic: a reload cannot extend the record (no wall
  // clock in the backfill), so actor restarts never re-arm the credential.
  const firstExpiry = record.expiresAt;
  const reloaded = new CoordinatorCore({
    store: rig.store,
    git: rig.git,
    radar: new StubRadar(),
    clock: fakeClock(),
    ids: fixedIds,
  });
  strictEqual(await reloaded.credentialAgent("legacy-token-plaintext"), null, "still denied after reload");
  const reloadedModel = await rig.store.get<CoordinatorModel>("model");
  ok(reloadedModel?.agentTokens["legacy-0001"], "record expected after reload");
  strictEqual(reloadedModel.agentTokens["legacy-0001"].expiresAt, firstExpiry, "no extension on reload");

  // Revoking a migrated agent still works and keeps the credential denied.
  strictEqual(await migrated.revokeAgentToken("legacy-0001"), true);
  strictEqual(await migrated.credentialAgent("legacy-token-plaintext"), null);
});
