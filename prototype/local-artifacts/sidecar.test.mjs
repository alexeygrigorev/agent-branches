import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startSidecar } from "./sidecar.mjs";

const run = promisify(execFile);

const SHARED_TOKEN = "sidecar-shared-secret";
let root;
let sidecarHandle;
let baseUrl;
let captured;
let captureServer;

// Webhook capture: stands in for the Worker's POST /events/push.
const webhookPushes = [];

before(async () => {
  root = mkdtempSync(join(tmpdir(), "agent-branches-sidecar-test-"));
  captureServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      webhookPushes.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"accepted":true}');
    });
  });
  captured = await new Promise((resolveListen) => {
    captureServer.listen(0, "127.0.0.1", () => resolveListen(captureServer.address()));
  });
  sidecarHandle = await startSidecar({
    root,
    host: "127.0.0.1",
    port: 0,
    token: SHARED_TOKEN,
    notifyUrl: `http://127.0.0.1:${captured.port}/events/push`,
  });
  baseUrl = `http://127.0.0.1:${sidecarHandle.port}`;
});

after(async () => {
  await sidecarHandle.close();
  await new Promise((resolveClose) => captureServer.close(() => resolveClose()));
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
  // Same documented pattern as real Cloudflare Artifacts (git-protocol page).
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

describe("sidecar admin API auth", () => {
  it("rejects requests without the shared token", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 401);
  });

  it("serves health with the shared token", async () => {
    const { status, body } = await api("/api/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });
});

describe("sidecar repos on real git", () => {
  it("creates a repo with a real seeded commit", async () => {
    const { status, body } = await api("/api/repos", {
      method: "POST",
      body: JSON.stringify({ name: "canonical" }),
    });
    assert.equal(status, 201);
    assert.match(body.seedCommit, /^[0-9a-f]{40}$/);
    assert.equal(body.defaultBranch, "main");
    assert.match(body.token, /^art_v1_[0-9a-f]{40}\?expires=\d+$/);
    assert.ok(body.remote.startsWith(`${baseUrl}/git/canonical.git`));

    const head = await api("/api/repos/canonical/head");
    assert.equal(head.body.sha, body.seedCommit);

    const log = await api("/api/repos/canonical/log?limit=5");
    assert.equal(log.body.length, 1);
    assert.equal(log.body[0].id, body.seedCommit);
    assert.equal(log.body[0].message, "chore: seed canonical baseline");
  });

  it("rejects duplicate repos and invalid names", async () => {
    const dup = await api("/api/repos", { method: "POST", body: JSON.stringify({ name: "canonical" }) });
    assert.equal(dup.status, 409);
    const evil = await api("/api/repos", { method: "POST", body: JSON.stringify({ name: "../escape" }) });
    assert.equal(evil.status, 400);
    const missing = await api("/api/repos/nope/head");
    assert.equal(missing.status, 404);
  });

  it("verifies commits with real git cat-file", async () => {
    const seed = (await api("/api/repos/canonical/head")).body.sha;
    const known = await api(`/api/repos/canonical/hascommit?sha=${seed}`);
    assert.equal(known.body.known, true);
    const unknown = await api(`/api/repos/canonical/hascommit?sha=${"0".repeat(40)}`);
    assert.equal(unknown.body.known, false);
  });

  it("forks with git clone --bare and can pin an explicit base", async () => {
    const seed = (await api("/api/repos/canonical/head")).body.sha;
    const forked = await api("/api/repos/canonical/fork", {
      method: "POST",
      body: JSON.stringify({ target: "canonical-agent-1" }),
    });
    assert.equal(forked.status, 201);
    assert.equal(forked.body.head, seed);

    const again = await api("/api/repos/canonical/fork", {
      method: "POST",
      body: JSON.stringify({ target: "canonical-agent-1" }),
    });
    assert.equal(again.status, 409);

    const badBase = await api("/api/repos/canonical/fork", {
      method: "POST",
      body: JSON.stringify({ target: "canonical-agent-2", baseSha: "f".repeat(40) }),
    });
    assert.equal(badBase.status, 400);

    const pinned = await api("/api/repos/canonical/fork", {
      method: "POST",
      body: JSON.stringify({ target: "canonical-agent-3", baseSha: seed }),
    });
    assert.equal(pinned.status, 201);
    assert.equal(pinned.body.head, seed);
  });

  it("creates real commits via the plumbing helper (test/dev path)", async () => {
    const commit = await api("/api/repos/canonical/agent-1/commits", {
      method: "POST",
      body: JSON.stringify({ message: "wip: helper commit" }),
    }).catch(async () => {
      // repo name above 404s; use a fresh fork
      return undefined;
    });
    const target = await api("/api/repos/canonical/fork", {
      method: "POST",
      body: JSON.stringify({ target: "canonical-helper" }),
    });
    const created = await api("/api/repos/canonical-helper/commits", {
      method: "POST",
      body: JSON.stringify({ message: "wip: helper commit" }),
    });
    assert.equal(created.status, 201);
    assert.match(created.body.id, /^[0-9a-f]{40}$/);
    const log = await api("/api/repos/canonical-helper/log");
    assert.equal(log.body.length, 2);
    assert.equal(log.body[0].parents[0], log.body[1].id);
    assert.equal(log.body[0].message, "wip: helper commit");
    assert.ok(created.body.timestamp);
  });
});

describe("sidecar git smart HTTP with real git client", () => {
  it("clones, commits and pushes with ordinary git; post-receive notifies the worker", async () => {
    const created = await api("/api/repos/canonical/fork", {
      method: "POST",
      body: JSON.stringify({ target: "canonical-pusher" }),
    });
    const writeToken = created.body.token;
    const remote = gitUrl("canonical-pusher");
    const auth = gitAuthArgs(writeToken);

    const workdir = join(root, "workdir-push");
    mkdirSync(workdir, { recursive: true });
    await git([...auth, "clone", remote, "."], { cwd: workdir });
    writeFileSync(join(workdir, "change.txt"), "agent work\n");
    await git(["add", "change.txt"], { cwd: workdir });
    await git(["commit", "-m", "wip: agent change"], { cwd: workdir });
    const localHead = (await git(["rev-parse", "HEAD"], { cwd: workdir })).trim();
    await git([...auth, "push", "origin", "main"], { cwd: workdir });

    const head = await api("/api/repos/canonical-pusher/head");
    assert.equal(head.body.sha, localHead);

    const log = await api("/api/repos/canonical-pusher/log");
    assert.equal(log.body[0].id, localHead);
    assert.equal(log.body[0].message, "wip: agent change");

    // post-receive -> sidecar /hooks/push -> worker notify URL
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 500));
    const webhook = webhookPushes.find((p) => p.body.fork === "canonical-pusher");
    assert.ok(webhook, "worker webhook fired for the push");
    assert.equal(webhook.url, "/events/push");
    assert.equal(webhook.body.sha, localHead);
    assert.equal(webhook.body.ref, "refs/heads/main");
  });

  it("rejects pushes with an invalid token", async () => {
    const workdir = join(root, "workdir-bad");
    mkdirSync(workdir, { recursive: true });
    await assert.rejects(
      git([...gitAuthArgs("art_v1_deadbeef"), "clone", gitUrl("canonical-pusher"), "."], { cwd: workdir }),
      /authentication|401|fatal/i,
    );
  });

  it("read-scoped tokens can clone but not push", async () => {
    const minted = await api("/api/repos/canonical-pusher/tokens", {
      method: "POST",
      body: JSON.stringify({ scope: "read", ttlSeconds: 600 }),
    });
    assert.equal(minted.status, 201);
    assert.equal(minted.body.scope, "read");
    const readRemote = gitUrl("canonical-pusher");
    const readAuth = gitAuthArgs(minted.body.plaintext);

    const workdir = join(root, "workdir-read");
    mkdirSync(workdir, { recursive: true });
    await git([...readAuth, "clone", readRemote, "."], { cwd: workdir });
    writeFileSync(join(workdir, "more.txt"), "more\n");
    await git(["add", "more.txt"], { cwd: workdir });
    await git(["commit", "-m", "should not land"], { cwd: workdir });
    await assert.rejects(
      git([...readAuth, "push", "origin", "main"], { cwd: workdir }),
      /40[13]|Pushing to|rejected|fatal/i,
    );
  });
});

describe("sidecar misc", () => {
  it("lists and deletes repos", async () => {
    const listed = await api("/api/repos");
    assert.ok(listed.body.repos.some((r) => r.name === "canonical"));
    const deleted = await api("/api/repos/canonical-agent-3", { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    const gone = await api("/api/repos/canonical-agent-3/head");
    assert.equal(gone.status, 404);
  });
});
