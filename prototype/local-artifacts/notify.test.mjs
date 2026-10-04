/**
 * codex C-1357: a git push whose Worker callback (post-receive ->
 * /events/push) fails auth/delivery must NOT become a silent "no warnings".
 * The sidecar retries a bounded number of times, then records the push as
 * UNPROCESSED (durable JSON under the sidecar root), exposed at
 * GET /api/notify-state for the Worker's GET /status to surface.
 * A later successful delivery for the same repo+ref supersedes (clears)
 * earlier unprocessed records; an unconfigured notify URL is NOT a failure.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startSidecar } from "./sidecar.mjs";

const run = promisify(execFile);

const SHARED_TOKEN = "notify-shared-secret";
let root;
let sidecarHandle;
let baseUrl;
let webhookServer;
let webhookPort;

/** "ok" -> 200; "fail" -> 503. Counts every received request. */
let webhookMode = "ok";
const webhookCalls = [];

before(async () => {
  root = mkdtempSync(join(tmpdir(), "agent-branches-notify-test-"));
  webhookServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      webhookCalls.push({ url: req.url, body: JSON.parse(body) });
      if (webhookMode === "ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"accepted":true}');
      } else {
        res.writeHead(503, { "content-type": "application/json" });
        res.end('{"error":"worker callback unavailable"}');
      }
    });
  });
  webhookPort = await new Promise((resolveListen) => {
    webhookServer.listen(0, "127.0.0.1", () => resolveListen(webhookServer.address().port));
  });
  sidecarHandle = await startSidecar({
    root,
    host: "127.0.0.1",
    port: 0,
    token: SHARED_TOKEN,
    notifyUrl: `http://127.0.0.1:${webhookPort}/events/push`,
  });
  baseUrl = `http://127.0.0.1:${sidecarHandle.port}`;
  // Each test file boots its OWN sidecar with an empty root; the canonical
  // baseline repo must exist here before tests fork from it.
  const seeded = await api("/api/repos", { method: "POST", body: JSON.stringify({ name: "canonical" }) });
  assert.equal(seeded.status, 201);
});

after(async () => {
  await sidecarHandle.close();
  await new Promise((resolveClose) => webhookServer.close(() => resolveClose()));
  rmSync(root, { recursive: true, force: true });
});

async function api(path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SHARED_TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json();
  return { status: res.status, body };
}

function gitUrl(name) {
  return `http://127.0.0.1:${sidecarHandle.port}/git/${name}.git`;
}

function gitAuthArgs(token) {
  return ["-c", `http.extraHeader=Authorization: Bearer ${token}`];
}

async function git(args, opts = {}) {
  const { stdout } = await run("git", args, {
    ...opts,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "tester",
      GIT_AUTHOR_EMAIL: "tester@test",
      GIT_COMMITTER_NAME: "tester",
      GIT_COMMITTER_EMAIL: "tester@test",
      ...(opts.env ?? {}),
    },
  });
  return stdout;
}

async function commitAndPush(workdir, repo, token, message) {
  mkdirSync(workdir, { recursive: true });
  if (!existsSync(join(workdir, ".git"))) {
    await git([...gitAuthArgs(token), "clone", gitUrl(repo), "."], { cwd: workdir });
  }
  writeFileSync(join(workdir, `f-${Date.now()}-${Math.random().toString(16).slice(2)}`), "agent work\n");
  await git(["add", "-A"], { cwd: workdir });
  await git(["commit", "-m", message], { cwd: workdir });
  const head = (await git(["rev-parse", "HEAD"], { cwd: workdir })).trim();
  await git([...gitAuthArgs(token), "push", "origin", "main"], { cwd: workdir });
  return head;
}

async function unprocessedFor(repo, sha) {
  const { body } = await api("/api/notify-state");
  return (body.unprocessed ?? []).find((r) => r.repo === repo && (sha === undefined || r.sha === sha));
}

describe("worker callback failure guard (codex C-1357)", () => {
  it("notify-state requires the shared bearer", async () => {
    const res = await fetch(`${baseUrl}/api/notify-state`);
    assert.equal(res.status, 401);
  });

  it("a push whose callback fails still lands in git, is retried boundedly, then recorded unprocessed", async () => {
    const created = await api("/api/repos/canonical/fork", {
      method: "POST",
      body: JSON.stringify({ target: "notify-agent-1" }),
    });
    assert.equal(created.status, 201);
    const token = created.body.token;

    webhookMode = "fail";
    webhookCalls.length = 0;
    const workdir = join(root, "workdir-fail");
    const head = await commitAndPush(workdir, "notify-agent-1", token, "wip: callback will fail");

    // The git push itself must succeed (notify failures never fail the push).
    const headAfter = await api("/api/repos/notify-agent-1/head");
    assert.equal(headAfter.body.sha, head);

    // Bounded retries: exactly 3 attempts for this sha (not 1, not unbounded).
    await new Promise((r) => setTimeout(r, 150));
    const attempts = webhookCalls.filter((c) => c.body.sha === head && c.body.fork === "notify-agent-1");
    assert.equal(attempts.length, 3, `expected 3 bounded attempts, saw ${attempts.length}`);
    assert.ok(attempts.every((c) => c.url === "/events/push"));

    // The push is recorded as unprocessed with the reason.
    const record = await unprocessedFor("notify-agent-1", head);
    assert.ok(record, "unprocessed record exists");
    assert.equal(record.ref, "refs/heads/main");
    assert.equal(record.sha, head);
    assert.equal(record.attempts, 3);
    assert.match(record.lastError, /503|worker/);
    assert.ok(record.firstAt && record.lastAt);
  });

  it("a later successful delivery for the same repo+ref supersedes the unprocessed record", async () => {
    // Still unprocessed from the previous test.
    assert.ok(await unprocessedFor("notify-agent-1"), "precondition: record present");
    webhookMode = "ok";
    const token = (
      await api("/api/repos/notify-agent-1/tokens", {
        method: "POST",
        body: JSON.stringify({ scope: "write", ttlSeconds: 600 }),
      })
    ).body.plaintext;
    await commitAndPush(join(root, "workdir-fail"), "notify-agent-1", token, "wip: callback works now");
    await new Promise((r) => setTimeout(r, 150));
    const record = await unprocessedFor("notify-agent-1");
    assert.equal(record, undefined, "superseding successful delivery cleared the record");
  });

  it("a redelivery of the exact missed sha succeeding clears its own record", async () => {
    // Produce a fresh unprocessed record...
    webhookMode = "fail";
    const token = (
      await api("/api/repos/notify-agent-1/tokens", {
        method: "POST",
        body: JSON.stringify({ scope: "write", ttlSeconds: 600 }),
      })
    ).body.plaintext;
    const missed = await commitAndPush(join(root, "workdir-fail"), "notify-agent-1", token, "wip: missed sha");
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(await unprocessedFor("notify-agent-1", missed), "precondition: missed sha recorded");

    // ...then heal it by redelivering the SAME push (what a recovery worker
    // or a manual hook replay would do) with the worker healthy again.
    webhookMode = "ok";
    const before = await api("/api/repos/notify-agent-1/log?limit=1");
    const replay = await fetch(`${baseUrl}/hooks/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "notify-agent-1",
        ref: "refs/heads/main",
        before: before.body[0].parents[0]?.id ?? null,
        after: missed,
      }),
    });
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.forwarded, true);
    assert.equal(await unprocessedFor("notify-agent-1", missed), undefined);
  });

  it("an unconfigured notify URL is not a delivery failure (no unprocessed records)", async () => {
    const bareRoot = mkdtempSync(join(tmpdir(), "agent-branches-notify-bare-"));
    let bareHandle;
    try {
      bareHandle = await startSidecar({ root: bareRoot, host: "127.0.0.1", port: 0, token: SHARED_TOKEN });
      const bareBase = `http://127.0.0.1:${bareHandle.port}`;
      const created = await (
        await fetch(`${bareBase}/api/repos`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${SHARED_TOKEN}` },
          body: JSON.stringify({ name: "lonely" }),
        })
      ).json();
      const replay = await fetch(`${bareBase}/hooks/push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "lonely", ref: "refs/heads/main", before: created.seedCommit, after: created.seedCommit }),
      });
      const body = await replay.json();
      assert.equal(body.forwarded, false);
      assert.match(body.reason, /notify url not configured/);
      assert.equal(body.unprocessed, undefined);
      const state = await (
        await fetch(`${bareBase}/api/notify-state`, {
          headers: { authorization: `Bearer ${SHARED_TOKEN}` },
        })
      ).json();
      assert.deepEqual(state.unprocessed, []);
    } finally {
      if (bareHandle) await bareHandle.close();
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });
});
