import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, SIDECAR_TOKEN, sidecarCommit } from "./helpers.js";
import { SEEN_PUSHES_CAP_PER_AGENT } from "../src/coordinator.js";

/** Integration through the Worker, backed by REAL bare git repos on the
 *  local sidecar (C-1309): every sha below comes from actual git commits. */
async function post(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return SELF.fetch(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function get(path: string): Promise<Response> {
  // C1462 Task 1: reads are bearer-gated; the suite reads as admin.
  return SELF.fetch(`http://localhost${path}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface CreatedTask {
  taskId: string;
  agentId: string;
  fork: { name: string; remote: string };
  token: { scope: string; plaintext: string; expiresAt: string };
  head: string | null;
}

interface PushResult {
  accepted: boolean;
  deduped: boolean;
  agent?: string;
  heads: Record<string, string>;
  invalidatedWarnings: string[];
  newWarnings: unknown[];
  radarChecks: number;
}

interface StatusSnapshot {
  canonical: { name: string | null; remote: string | null };
  agents: { agentId: string; forkName: string; head: string | null; pushes: number }[];
  heads: Record<string, string>;
  pairs: { pair: string[]; heads: { a: string; b: string }; status: string; stale: boolean }[];
  warnings: { id: string; status: string }[];
  radarLog: { pair: string[]; status: string }[];
}

describe("Agent Branches coordinator flow (sidecar-backed)", () => {
  it("sets up the canonical repo with a real seeded commit", async () => {
    const response = await post("/setup", {}, ADMIN_TOKEN);
    expect(response.status).toBe(201);
    const body = await json<{ canonical: { name: string; remote: string }; created: boolean; seedCommit: string | null }>(response);
    expect(body.canonical.name).toMatch(/^agent-branches-canonical-[0-9a-f]{8}$/);
    expect(body.canonical.remote).toContain("/git/agent-branches-canonical-");
    expect(body.created).toBe(true);
    expect(body.seedCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("creates two agent tasks as real forks of canonical", async () => {
    const alpha = await post("/tasks", { agent: "alpha" }, ADMIN_TOKEN);
    expect(alpha.status).toBe(201);
    const alphaBody = await json<CreatedTask>(alpha);
    expect(alphaBody.agentId).toBe("alpha-0001");
    expect(alphaBody.taskId).toBe("task-0001");
    expect(alphaBody.fork.name).toMatch(/^agent-branches-canonical-[0-9a-f]{8}-alpha-0001$/);
    expect(alphaBody.fork.remote).toMatch(/\/git\/agent-branches-canonical-[0-9a-f]{8}-alpha-0001\.git$/);
    expect(alphaBody.token.scope).toBe("write");
    expect(alphaBody.token.plaintext).toMatch(/^art_v1_[0-9a-f]{40}\?expires=\d+$/);

    const beta = await post("/tasks", { agent: "beta" }, ADMIN_TOKEN);
    expect(beta.status).toBe(201);
    const betaBody = await json<CreatedTask>(beta);
    expect(betaBody.agentId).toBe("beta-0002");
    expect(betaBody.head).toBe(alphaBody.head);
    expect(alphaBody.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("accepts a real WIP head, no warning just because heads differ", async () => {
    const alphaBody = await json<CreatedTask>(await post("/tasks", { agent: "pusher" }, ADMIN_TOKEN));
    const betaBody = await json<CreatedTask>(await post("/tasks", { agent: "peer" }, ADMIN_TOKEN));
    expect(alphaBody.head).toBe(betaBody.head);

    const wip = await sidecarCommit(alphaBody.fork.name, "wip: alpha first change");
    const push = await post("/events/push", { agent: alphaBody.agentId, sha: wip }, alphaBody.token.plaintext);
    expect(push.status).toBe(200);
    const body = await json<PushResult>(push);
    expect(body.accepted).toBe(true);
    expect(body.deduped).toBe(false);
    expect(body.agent).toBe(alphaBody.agentId);
    expect(body.heads[alphaBody.agentId]).toBe(wip);
    // one check per existing sibling pair (earlier tests added more agents)
    expect(body.radarChecks).toBeGreaterThanOrEqual(1);
    expect(body.newWarnings).toEqual([]);

    const status = await json<StatusSnapshot>(await get("/status"));
    expect(status.heads[alphaBody.agentId]).toBe(wip);
    expect(status.warnings).toEqual([]);
    const mine = status.pairs.find((p) => p.pair.includes(alphaBody.agentId) && p.pair.includes(betaBody.agentId));
    expect(mine?.status).toBe("not_checked");
    expect(status.radarLog[0].status).toBe("not_checked");
  });

  it("resolves the agent from the fork when only {fork, sha} is posted (webhook shape)", async () => {
    const created = await json<CreatedTask>(await post("/tasks", { agent: "hooked" }, ADMIN_TOKEN));
    const wip = await sidecarCommit(created.fork.name, "wip: pushed via git");
    // Webhook credential: the sidecar's shared bearer (CONTRACT 0.1.1).
    const viaFork = await post(
      "/events/push",
      { fork: created.fork.name, ref: "refs/heads/main", sha: wip },
      SIDECAR_TOKEN,
    );
    expect(viaFork.status).toBe(200);
    const body = await json<PushResult>(viaFork);
    expect(body.agent).toBe(created.agentId);
    expect(body.heads[created.agentId]).toBe(wip);
  });

  it("dedups repeated pushes per (agent, sha)", async () => {
    const created = await json<CreatedTask>(await post("/tasks", { agent: "dedup" }, ADMIN_TOKEN));
    const wip = await sidecarCommit(created.fork.name, "wip: only once");
    await post("/events/push", { agent: created.agentId, sha: wip }, ADMIN_TOKEN);
    const again = await json<PushResult>(
      await post("/events/push", { agent: created.agentId, sha: wip }, ADMIN_TOKEN),
    );
    expect(again.accepted).toBe(true);
    expect(again.deduped).toBe(true);
    expect(again.radarChecks).toBe(0);
  });

  it("bounds the per-agent push-dedup memory (muse-r46 D2)", async () => {
    const created = await json<CreatedTask>(await post("/tasks", { agent: "ring" }, ADMIN_TOKEN));
    const shas: string[] = [];
    for (let i = 0; i < SEEN_PUSHES_CAP_PER_AGENT + 2; i++) {
      shas.push(await sidecarCommit(created.fork.name, `wip: ring ${i}`));
    }
    for (const sha of shas) {
      const res = await json<PushResult>(await post("/events/push", { agent: created.agentId, sha }, ADMIN_TOKEN));
      expect(res.deduped).toBe(false);
    }
    // Still inside the ring (and not the current head): redelivery is deduped.
    const inRing = await json<PushResult>(
      await post("/events/push", { agent: created.agentId, sha: shas[shas.length - 2] }, ADMIN_TOKEN),
    );
    expect(inRing.deduped).toBe(true);
    // Evicted from the ring window: the oldest redelivery is treated as new
    // (bounded memory) instead of accumulating forever.
    const evicted = await json<PushResult>(
      await post("/events/push", { agent: created.agentId, sha: shas[0] }, ADMIN_TOKEN),
    );
    expect(evicted.deduped).toBe(false);
  });

  it("rejects shas that are not real commits in the fork", async () => {
    const created = await json<CreatedTask>(await post("/tasks", { agent: "strict" }, ADMIN_TOKEN));
    const foreign = await sidecarCommit("no-such-repo-will-exist-x", "x").catch(() => null);
    expect(foreign).toBeNull();
    const unknown = await post("/events/push", { agent: created.agentId, sha: "0".repeat(40) }, ADMIN_TOKEN);
    expect(unknown.status).toBe(400);
    const body = await json<{ error: string }>(unknown);
    expect(body.error).toContain("not found");
  });

  it("serves task details and 404s unknown tasks", async () => {
    const created = await json<CreatedTask>(await post("/tasks", { agent: "detail" }, ADMIN_TOKEN));
    const found = await get(`/tasks/${created.taskId}`);
    expect(found.status).toBe(200);
    const body = await json<{ agentId: string; head: string | null; pushes: number }>(found);
    expect(body.agentId).toBe(created.agentId);
    expect(body.head).toBe(created.head);
    expect(body.pushes).toBe(0);

    const missing = await get("/tasks/task-9999");
    expect(missing.status).toBe(404);
  });

  it("accepts the documented cf.artifacts.repo.pushed envelope with a real commit", async () => {
    const created = await json<CreatedTask>(await post("/tasks", { agent: "envelope" }, ADMIN_TOKEN));
    const next = await sidecarCommit(created.fork.name, "wip: envelope-driven");
    const event = {
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: "local", repoName: created.fork.name },
      payload: {
        ref: "refs/heads/main",
        before: created.head,
        after: next,
        commits: [
          {
            id: next,
            message: "wip: envelope-driven",
            messageTruncated: false,
            timestamp: "2026-10-03T12:00:00.000Z",
            parents: [created.head],
          },
        ],
        totalCommitsCount: 1,
        commitsTruncated: false,
      },
      metadata: {
        accountId: "local",
        eventSubscriptionId: "test",
        eventSchemaVersion: 1,
        eventTimestamp: "2026-10-03T12:00:00.132Z",
      },
    };
    const response = await post("/events/artifacts", event, SIDECAR_TOKEN);
    expect(response.status).toBe(200);
    const body = await json<{ accepted: boolean; deduped: boolean; heads: Record<string, string> }>(response);
    expect(body.accepted).toBe(true);
    expect(body.deduped).toBe(false);
    expect(body.heads[created.agentId]).toBe(next);

    const ignored = await post(
      "/events/artifacts",
      {
        ...event,
        source: { type: "artifacts.repo", namespace: "local", repoName: "who-knows" },
      },
      SIDECAR_TOKEN,
    );
    expect(ignored.status).toBe(202);
  });

  it("rejects unknown agents and wrong forks", async () => {
    const unknownAgent = await post("/events/push", { agent: "ghost-9999", sha: "f".repeat(40) }, ADMIN_TOKEN);
    expect(unknownAgent.status).toBe(400);

    const created = await json<CreatedTask>(await post("/tasks", { agent: "owner" }, ADMIN_TOKEN));
    const wrongFork = await post(
      "/events/push",
      {
        agent: created.agentId,
        fork: "somebody-elses-fork",
        sha: "e".repeat(40),
      },
      created.token.plaintext,
    );
    expect(wrongFork.status).toBe(400);

    const missingSha = await post("/events/push", { agent: created.agentId }, ADMIN_TOKEN);
    expect(missingSha.status).toBe(400);

    const noRoute = await get("/definitely/not/a/route");
    expect(noRoute.status).toBe(404);
  });
});
