import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, RUNNER_TOKEN, sidecarCommit } from "./helpers.js";

/**
 * Persistence across DO restart (codex C-1305 #4): evicting the Durable
 * Object tears down its in-memory state while durable storage and the
 * sidecar's on-disk repos survive; the next request must reconstruct.
 * Concurrency: simultaneous createTask calls must not duplicate forks or
 * lose updates.
 */
async function post(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return SELF.fetch(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function get(path: string): Promise<Response> {
  // C1462 Task 1: reads are bearer-gated; the suite reads as admin.
  return SELF.fetch(`http://localhost${path}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function coordinatorStub(): DurableObjectStub {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName("global"));
}

describe("persistence across DO restart", () => {
  it("reconstructs heads, tasks, warnings, acks and pair checks from storage", async () => {
    const created = await json<{ taskId: string; agentId: string; fork: { name: string }; head: string; token: { plaintext: string } }>(
      await post("/tasks", { agent: "survivor", intent: "persist me" }, ADMIN_TOKEN),
    );
    const other = await json<{ agentId: string; fork: { name: string }; token: { plaintext: string } }>(
      await post("/tasks", { agent: "witness" }, ADMIN_TOKEN),
    );
    const sha = await sidecarCommit(created.fork.name, "wip: pre-restart work");
    await post("/events/push", { agent: created.agentId, sha }, ADMIN_TOKEN);
    const witnessSha = await sidecarCommit(other.fork.name, "wip: witness work");
    await post("/events/push", { agent: other.agentId, sha: witnessSha }, ADMIN_TOKEN);

    const vector = (await json<{ heads: Record<string, string> }>(await get("/status"))).heads;
    const checked = await json<{ createdWarnings: { id: string }[] }>(
      await post(
        "/checks",
        {
          contract: "0.0",
          vector,
          policy: "restart-policy",
          results: [{ pair: [created.agentId, other.agentId], status: "conflict", kind: "merge-conflict" }],
        },
        RUNNER_TOKEN,
      ),
    );
    const warningId = checked.createdWarnings[0].id;
    await post(
      `/warnings/${warningId}/ack`,
      { agent: created.agentId, note: "seen before restart" },
      created.token.plaintext,
    );

    const before = await json<{
      canonical: { name: string | null };
      heads: Record<string, string>;
      warnings: { id: string; status: string; acks: { note?: string }[] }[];
      lastRunnerReport: { policy: string } | null;
    }>(await get("/status"));

    // Simulate the DO isolate restarting: memory torn down, storage kept.
    await evictDurableObject(coordinatorStub());

    const after = await json<{
      canonical: { name: string | null };
      agents: { agentId: string; forkName: string }[];
      heads: Record<string, string>;
      pairs: { pair: string[]; status: string; activeWarningIds: string[] }[];
      warnings: { id: string; status: string; acks: { note?: string }[] }[];
      lastRunnerReport: { policy: string } | null;
    }>(await get("/status"));
    expect(after.canonical.name).toBe(before.canonical.name);
    expect(after.heads).toEqual(before.heads);
    expect(after.heads[created.agentId]).toBe(sha);
    const warning = after.warnings.find((w) => w.id === warningId);
    expect(warning?.status).toBe("active");
    expect(warning?.acks[0]?.note).toBe("seen before restart");
    expect(after.lastRunnerReport?.policy).toBe("restart-policy");
    const pair = after.pairs.find((p) => p.pair.includes(created.agentId) && p.pair.includes(other.agentId));
    expect(pair?.status).toBe("conflict");

    // Task detail (incl. base_sha, intent, pushes) survives...
    const detail = await json<{ base_sha: string; intent: string | null; pushes: number }>(
      await get(`/tasks/${created.taskId}`),
    );
    expect(detail.intent).toBe("persist me");
    expect(detail.pushes).toBe(1);
    expect(detail.base_sha).toMatch(/^[0-9a-f]{40}$/);

    // ...and the DO still cooperates with the (unrestarted) sidecar repos:
    // a new real commit on the same fork is accepted after the restart.
    const postRestartSha = await sidecarCommit(created.fork.name, "wip: post-restart work");
    const push = await post("/events/push", { agent: created.agentId, sha: postRestartSha }, ADMIN_TOKEN);
    expect(push.status).toBe(200);
    const finalStatus = await json<{ heads: Record<string, string> }>(await get("/status"));
    expect(finalStatus.heads[created.agentId]).toBe(postRestartSha);
  });
});

describe("concurrent createTask", () => {
  it("two simultaneous createTask calls produce two distinct forks (no duplicate/lost update)", async () => {
    const responses = await Promise.all([
      post("/tasks", { agent: "racer", intent: "race a" }, ADMIN_TOKEN),
      post("/tasks", { agent: "racer", intent: "race b" }, ADMIN_TOKEN),
    ]);
    const bodies = [];
    for (const response of responses) {
      expect(response.status).toBe(201);
      bodies.push(
        (await response.json()) as { taskId: string; agentId: string; fork: { name: string }; head: string },
      );
    }
    const ids = new Set(bodies.map((b) => b.agentId));
    const forks = new Set(bodies.map((b) => b.fork.name));
    const taskIds = new Set(bodies.map((b) => b.taskId));
    expect(ids.size).toBe(2);
    expect(forks.size).toBe(2);
    expect(taskIds.size).toBe(2);

    const status = await json<{ heads: Record<string, string>; agents: { agentId: string; pushes: number }[] }>(
      await get("/status"),
    );
    for (const body of bodies) {
      expect(status.heads[body.agentId]).toBe(body.head);
      expect(status.agents.some((a) => a.agentId === body.agentId)).toBe(true);
    }
    // Both tasks fully readable, both forks real on the sidecar (log works).
    for (const body of bodies) {
      const detail = await json<{ intent: string | null; base_sha: string }>(await get(`/tasks/${body.taskId}`));
      expect(detail.base_sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("a wider burst stays consistent", async () => {
    const responses = await Promise.all(
      ["burst-1", "burst-2", "burst-3", "burst-4"].map((agent) => post("/tasks", { agent }, ADMIN_TOKEN)),
    );
    const bodies = await Promise.all(
      responses.map(async (r) => {
        expect(r.status).toBe(201);
        return (await r.json()) as { agentId: string; fork: { name: string } };
      }),
    );
    expect(new Set(bodies.map((b) => b.agentId)).size).toBe(4);
    const status = await json<{ agents: { agentId: string }[] }>(await get("/status"));
    const inStatus = new Set(status.agents.map((a) => a.agentId));
    for (const body of bodies) {
      expect(inStatus.has(body.agentId)).toBe(true);
    }
  });
});
