/**
 * End-to-end proof that the core serves the wire routes over REAL node:http
 * with NO workerd and NO Cloudflare (facade extraction, 2026-10-03). The
 * server under test is src/local/runtime.ts serveCoordinator, wired to the
 * CoordinatorCore with the same in-memory fakes as the other node tests.
 */

import { test } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { makeRig } from "./fakes.js";
import { serveCoordinator } from "../../src/local/runtime.js";

async function withServer(run: (base: string, rig: ReturnType<typeof makeRig>) => Promise<void>): Promise<void> {
  const rig = makeRig();
  const server = serveCoordinator(rig.services);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  ok(address, "server must report its address after listen");
  try {
    await run(`http://127.0.0.1:${address.port}`, rig);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("local node:http runtime serves the same routes from the core", async () => {
  await withServer(async (base, rig) => {
    // GET /status before anything: empty coordinator state (C1462 Task 1:
    // reads are bearer-gated like every other route).
    const initial = await fetch(`${base}/status`, { headers: { authorization: "Bearer admin-t" } });
    strictEqual(initial.status, 200);
    deepStrictEqual((await initial.json() as { heads: Record<string, string> }).heads, {});

    // Auth ladder over real HTTP.
    strictEqual((await fetch(`${base}/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    const setup = await fetch(`${base}/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-t" },
      body: "{}",
    });
    strictEqual(setup.status, 201);

    // Create a task and push through the webhook shape.
    const created = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-t" },
      body: JSON.stringify({ agent: "http" }),
    });
    strictEqual(created.status, 201);
    const task = await created.json() as { taskId: string; agentId: string; fork: { name: string }; head: string | null };
    ok(task.taskId === "task-0001");

    const sha = rig.git.commit(task.fork.name, "wip: over real http");
    const push = await fetch(`${base}/events/push`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sidecar-t" },
      body: JSON.stringify({ fork: task.fork.name, ref: "refs/heads/main", sha }),
    });
    strictEqual(push.status, 200);
    const pushBody = await push.json() as { accepted: boolean; agent: string };
    strictEqual(pushBody.accepted, true);
    strictEqual(pushBody.agent, task.agentId);

    // Status reflects the move; task detail resolves (owner token reads).
    const status = await fetch(`${base}/status`, { headers: { authorization: "Bearer admin-t" } });
    const statusBody = await status.json() as { heads: Record<string, string> };
    strictEqual(statusBody.heads[task.agentId], sha);

    const detail = await fetch(`${base}/tasks/${task.taskId}`, { headers: { authorization: "Bearer admin-t" } });
    strictEqual(detail.status, 200);
    strictEqual(((await detail.json()) as { pushes: number }).pushes, 1);

    // 404 still shapes the same.
    const missing = await fetch(`${base}/tasks/task-9999`, { headers: { authorization: "Bearer admin-t" } });
    strictEqual(missing.status, 404);
  });
});

test("local runtime answers JSON errors for malformed bodies", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/events/push`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-t" },
      body: "{not json",
    });
    strictEqual(response.status, 400);
    deepStrictEqual(await response.json(), { error: "request body must be valid JSON" });
  });
});
