#!/usr/bin/env node
/**
 * Local Artifacts sidecar (codex C-1309 #7a / #9).
 *
 * Serves REAL bare git repos on disk for local development and tests:
 *   - JSON admin API consumed by the Worker over fetch (create/fork/token/
 *     head/log/hasCommit), guarded by an optional shared bearer token.
 *   - Git smart HTTP (clone/fetch/push) via `git http-backend`, authenticated
 *     with per-repo tokens so agents use ordinary `git push`.
 *   - post-receive hook -> POST /hooks/push -> forwarded to the Worker's
 *     POST /events/push (SIDECAR_NOTIFY_URL) as {fork, ref, sha, before}.
 *
 * Node built-ins + system git ONLY — no npm dependencies (#9).
 * Binds 127.0.0.1 by default; never logs tokens.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,127}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_BODY = 64 * 1024 * 1024;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function isValidRepoName(name) {
  return typeof name === "string" && NAME_RE.test(name) && !name.includes("..");
}

function isValidRef(ref) {
  return typeof ref === "string" && REF_RE.test(ref) && !ref.includes("..") && !ref.startsWith("-");
}

function hex40() {
  return randomBytes(20).toString("hex");
}

function gitEnv(extra = {}) {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "agent-branches",
    GIT_AUTHOR_EMAIL: "sidecar@agent-branches.local",
    GIT_COMMITTER_NAME: "agent-branches",
    GIT_COMMITTER_EMAIL: "sidecar@agent-branches.local",
    ...extra,
  };
}

function runGitBuffer(args, { cwd, input, env } = {}) {
  return new Promise((res, rej) => {
    const child = spawn("git", args, { cwd, env: env ?? gitEnv() });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", rej);
    child.on("close", (code) => {
      res({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

async function gitText(args, opts = {}) {
  const { code, stdout, stderr } = await runGitBuffer(args, opts);
  if (code !== 0) {
    const detail = stderr.trim().split("\n")[0] ?? "";
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
  return stdout.toString("utf8");
}

class TokenStore {
  constructor(root) {
    this.path = join(root, "state.json");
    this.tokens = [];
    if (existsSync(this.path)) {
      try {
        this.tokens = JSON.parse(readFileSync(this.path, "utf8")).tokens ?? [];
      } catch {
        this.tokens = [];
      }
    }
  }

  mint(repo, scope, ttlSeconds) {
    const expiresUnix = Math.floor(Date.now() / 1000) + (ttlSeconds ?? 3600);
    const record = {
      id: hex40().slice(0, 16),
      repo,
      scope: scope === "read" ? "read" : "write",
      expiresAt: new Date(expiresUnix * 1000).toISOString(),
      plaintext: `art_v1_${hex40()}?expires=${expiresUnix}`,
    };
    this.tokens.push(record);
    this.save();
    return record;
  }

  find(plaintext) {
    const record = this.tokens.find((t) => t.plaintext === plaintext);
    if (!record) {
      return null;
    }
    const m = /expires=(\d+)$/.exec(plaintext);
    if (m && Number(m[1]) < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return record;
  }

  dropRepo(repo) {
    this.tokens = this.tokens.filter((t) => t.repo !== repo);
    this.save();
  }

  save() {
    writeFileSync(this.path, JSON.stringify({ tokens: this.tokens }, null, 2));
  }
}

/**
 * Durable ledger of Worker-callback deliveries that failed after bounded
 * retries (codex C-1357). A push that the Worker never accepted must not
 * become a silent "no warnings" state: the record stays on disk until a
 * later successful delivery for the same repo+ref supersedes it (the Worker
 * then knows that ref moved at least that far), and GET /status surfaces it
 * via GET /api/notify-state. "notify url not configured" is NOT recorded —
 * that is the documented local no-worker mode, not a delivery failure.
 */
class NotifyLedger {
  constructor(root) {
    this.path = join(root, "notify-state.json");
    this.unprocessed = [];
    if (existsSync(this.path)) {
      try {
        this.unprocessed = JSON.parse(readFileSync(this.path, "utf8")).unprocessed ?? [];
      } catch {
        this.unprocessed = [];
      }
    }
  }

  find(repo, ref, sha) {
    return this.unprocessed.find((r) => r.repo === repo && r.ref === ref && r.sha === sha) ?? null;
  }

  record(entry) {
    this.unprocessed.push(entry);
    this.save();
    return entry;
  }

  /** Successful delivery for repo+ref: everything older on that ref is superseded. */
  clearRef(repo, ref) {
    const before = this.unprocessed.length;
    this.unprocessed = this.unprocessed.filter((r) => !(r.repo === repo && r.ref === ref));
    if (this.unprocessed.length !== before) {
      this.save();
    }
  }

  dropRepo(repo) {
    const before = this.unprocessed.length;
    this.unprocessed = this.unprocessed.filter((r) => r.repo !== repo);
    if (this.unprocessed.length !== before) {
      this.save();
    }
  }

  save() {
    writeFileSync(this.path, JSON.stringify({ unprocessed: this.unprocessed }, null, 2));
  }
}

/** Bounded delivery attempts before a push is recorded unprocessed (C-1357). */
const NOTIFY_ATTEMPTS = 3;
const NOTIFY_BACKOFF_MS = [50, 100, 200];

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export class Sidecar {
  constructor({ root, token, notifyUrl, baseUrl }) {
    this.root = resolve(root);
    this.reposDir = join(this.root, "repos");
    mkdirSync(this.reposDir, { recursive: true });
    this.sharedToken = token ?? null;
    this.notifyUrl = notifyUrl ?? null;
    this.baseUrlFn = baseUrl ?? null;
    this.tokens = new TokenStore(this.root);
    this.ledger = new NotifyLedger(this.root);
    this.port = null;
  }

  repoDir(name) {
    return join(this.reposDir, `${name}.git`);
  }

  baseUrl() {
    return this.baseUrlFn ? this.baseUrlFn() : `http://127.0.0.1:${this.port}`;
  }

  remoteFor(name) {
    return `${this.baseUrl()}/git/${name}.git`;
  }

  repoExists(name) {
    return existsSync(this.repoDir(name));
  }

  mustRepo(name) {
    if (!isValidRepoName(name) || !this.repoExists(name)) {
      throw new HttpError(404, `repo not found: ${name}`);
    }
    return this.repoDir(name);
  }

  installHook(name) {
    const dir = this.repoDir(name);
    const hooks = join(dir, "hooks");
    mkdirSync(hooks, { recursive: true });
    const hookPath = join(hooks, "post-receive");
    const notifyHook = join(HERE, "notify-hook.mjs");
    const internal = `${this.baseUrl()}/hooks/push`;
    writeFileSync(
      hookPath,
      `#!/bin/sh\nexec node ${JSON.stringify(notifyHook)} ${JSON.stringify(internal)} ${JSON.stringify(name)}\n`,
    );
    chmodSync(hookPath, 0o755);
  }

  async createRepo(name, { defaultBranch = "main", seedMessage = "chore: seed canonical baseline" } = {}) {
    if (!isValidRepoName(name)) {
      throw new HttpError(400, `invalid repo name: ${name}`);
    }
    if (this.repoExists(name)) {
      throw new HttpError(409, `repo already exists: ${name}`);
    }
    const dir = this.repoDir(name);
    await gitText(["init", "--bare", "--initial-branch", defaultBranch, dir]);
    const blob = (await gitText(["hash-object", "-w", "--stdin"], { cwd: dir, input: "agent-branches baseline\n" })).trim();
    const tree = (
      await gitText(["mktree"], {
        cwd: dir,
        input: `100644 blob ${blob}\tREADME.md\n`,
      })
    ).trim();
    const commit = (await gitText(["commit-tree", tree, "-m", seedMessage], { cwd: dir })).trim();
    await gitText(["update-ref", `refs/heads/${defaultBranch}`, commit], { cwd: dir });
    this.installHook(name);
    const token = this.tokens.mint(name, "write", 3600);
    return {
      name,
      remote: this.remoteFor(name),
      defaultBranch,
      token: token.plaintext,
      seedCommit: commit,
    };
  }

  async forkRepo(source, target, { baseSha } = {}) {
    const srcDir = this.mustRepo(source);
    if (!isValidRepoName(target)) {
      throw new HttpError(400, `invalid repo name: ${target}`);
    }
    if (this.repoExists(target)) {
      throw new HttpError(409, `repo already exists: ${target}`);
    }
    if (baseSha !== undefined && !SHA_RE.test(baseSha)) {
      throw new HttpError(400, "baseSha must be a 40-hex commit id");
    }
    const dir = this.repoDir(target);
    await gitText(["clone", "--bare", srcDir, dir]);
    const branch = (await gitText(["symbolic-ref", "--short", "HEAD"], { cwd: dir })).trim();
    if (baseSha !== undefined) {
      const check = await runGitBuffer(["cat-file", "-e", `${baseSha}^{commit}`], { cwd: dir });
      if (check.code !== 0) {
        rmSync(dir, { recursive: true, force: true });
        throw new HttpError(400, `fork base ${baseSha} not found in ${source}`);
      }
      await gitText(["update-ref", `refs/heads/${branch}`, baseSha], { cwd: dir });
    }
    this.installHook(target);
    const head = (await gitText(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: dir })).trim();
    const token = this.tokens.mint(target, "write", 3600);
    return { name: target, remote: this.remoteFor(target), defaultBranch: branch, token: token.plaintext, head };
  }

  async headCommit(name, ref = "HEAD") {
    const dir = this.mustRepo(name);
    if (!isValidRef(ref)) {
      throw new HttpError(400, `invalid ref: ${ref}`);
    }
    const { code, stdout } = await runGitBuffer(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: dir });
    return code === 0 ? stdout.toString("utf8").trim() : null;
  }

  async logRepo(name, { ref = "HEAD", limit = 50, offset = 0 } = {}) {
    const dir = this.mustRepo(name);
    if (!isValidRef(ref)) {
      throw new HttpError(400, `invalid ref: ${ref}`);
    }
    const lim = Math.max(1, Math.min(1000, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const fmt = "%H%x1f%P%x1f%aI%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e";
    const raw = await gitText(["log", `--format=${fmt}`, `-n`, String(lim), `--skip=${off}`, ref], { cwd: dir });
    const commits = [];
    for (const record of raw.split("\x1e")) {
      if (!record.trim()) {
        continue;
      }
      const [id, parents, aTime, aName, aEmail, cName, cEmail, message] = record.split("\x1f");
      commits.push({
        id: id.trim(),
        parents: parents.trim() ? parents.trim().split(" ") : [],
        timestamp: aTime.trim(),
        message: (message ?? "").replace(/\n$/, ""),
        author: { name: aName, email: aEmail },
        committer: { name: cName, email: cEmail },
      });
    }
    return commits;
  }

  async hasCommit(name, sha) {
    const dir = this.mustRepo(name);
    if (!SHA_RE.test(sha)) {
      return false;
    }
    const { code } = await runGitBuffer(["cat-file", "-e", `${sha}^{commit}`], { cwd: dir });
    return code === 0;
  }

  /** Dev/test helper: create a real commit on a ref via git plumbing. */
  async commitOn(name, { message, ref = "refs/heads/main" } = {}) {
    const dir = this.mustRepo(name);
    if (!isValidRef(ref)) {
      throw new HttpError(400, `invalid ref: ${ref}`);
    }
    if (typeof message !== "string" || message.length === 0) {
      throw new HttpError(400, "message is required");
    }
    const headRes = await runGitBuffer(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: dir });
    const tip = headRes.code === 0 ? headRes.stdout.toString("utf8").trim() : null;
    const tree = tip
      ? (await gitText(["rev-parse", `${tip}^{tree}`], { cwd: dir })).trim()
      : EMPTY_TREE;
    const args = ["commit-tree", tree, "-m", message];
    if (tip) {
      args.push("-p", tip);
    }
    const commit = (await gitText(args, { cwd: dir })).trim();
    await gitText(["update-ref", ref, commit], { cwd: dir });
    const commits = await this.logRepo(name, { ref, limit: 1 });
    return commits[0] ?? { id: commit, message, parents: tip ? [tip] : [], timestamp: new Date().toISOString() };
  }

  listRepos() {
    if (!existsSync(this.reposDir)) {
      return [];
    }
    return readdirSync(this.reposDir)
      .filter((entry) => entry.endsWith(".git"))
      .map((entry) => ({ name: entry.slice(0, -4), status: "ready" }));
  }

  deleteRepo(name) {
    const dir = this.mustRepo(name);
    rmSync(dir, { recursive: true, force: true });
    this.tokens.dropRepo(name);
    this.ledger.dropRepo(name);
    return true;
  }

  /** Git smart-HTTP auth: per-repo token; write scope required to push. */
  authorizeGit(repoName, req, needsWrite) {
    const header = req.headers.authorization ?? "";
    let plaintext = null;
    if (header.toLowerCase().startsWith("bearer ")) {
      plaintext = header.slice(7).trim();
    } else if (header.toLowerCase().startsWith("basic ")) {
      try {
        const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
        plaintext = decoded.slice(decoded.indexOf(":") + 1);
      } catch {
        plaintext = null;
      }
    }
    let record = plaintext ? this.tokens.find(plaintext) : null;
    if (!record && plaintext && plaintext.includes("%")) {
      try {
        record = this.tokens.find(decodeURIComponent(plaintext));
      } catch {}
    }
    if (!record || record.repo !== repoName) {
      throw new HttpError(401, "git authentication required: valid per-repo token");
    }
    if (needsWrite && record.scope !== "write") {
      throw new HttpError(401, "write token required for push");
    }
  }

  async forwardPush(push) {
    if (!this.notifyUrl) {
      // The documented local no-worker mode — not a delivery failure.
      return { forwarded: false, reason: "notify url not configured" };
    }
    const body = JSON.stringify({ fork: push.repo, ref: push.ref, sha: push.after, before: push.before });
    // muse-r46 AUTH (CONTRACT 0.1.1): the Worker token-gates /events/push;
    // the webhook authenticates with the same shared bearer (SIDECAR_TOKEN
    // must equal the Worker's LOCAL_ARTIFACTS_TOKEN).
    const headers = { "content-type": "application/json" };
    if (this.sharedToken) {
      headers.authorization = `Bearer ${this.sharedToken}`;
    }
    let lastError = null;
    for (let attempt = 1; attempt <= NOTIFY_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(this.notifyUrl, {
          method: "POST",
          headers,
          body,
        });
        if (res.ok) {
          // The Worker accepted a sha on this ref, so any earlier failed
          // delivery for the same repo+ref is superseded (its head tracking
          // is at least as new as this delivery).
          this.ledger.clearRef(push.repo, push.ref);
          return { forwarded: true, attempts: attempt };
        }
        lastError = `worker responded ${res.status}`;
      } catch (error) {
        lastError = `worker unreachable: ${error.message}`;
      }
      if (attempt < NOTIFY_ATTEMPTS) {
        await sleep(NOTIFY_BACKOFF_MS[attempt - 1]);
      }
    }
    // codex C-1357: a push the Worker never accepted must NOT degrade into a
    // silent "no warnings" state. Record it durably; GET /api/notify-state
    // feeds the Worker's GET /status, which then reports the agent's head as
    // not_checked with a reason until a successful delivery supersedes it.
    const now = new Date().toISOString();
    const existing = this.ledger.find(push.repo, push.ref, push.after);
    if (existing) {
      existing.attempts += NOTIFY_ATTEMPTS;
      existing.lastAt = now;
      existing.lastError = lastError;
      this.ledger.save();
    } else {
      this.ledger.record({
        repo: push.repo,
        ref: push.ref,
        sha: push.after,
        before: push.before ?? null,
        attempts: NOTIFY_ATTEMPTS,
        firstAt: now,
        lastAt: now,
        lastError,
      });
    }
    return { forwarded: false, reason: lastError, unprocessed: true, attempts: NOTIFY_ATTEMPTS };
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        rejectBody(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(payload);
}

async function handleGitCgi(sidecar, req, res, repoName, tail) {
  const url = new URL(req.url, "http://127.0.0.1");
  const needsWrite = tail === "git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";
  sidecar.authorizeGit(repoName, req, needsWrite);
  sidecar.mustRepo(repoName);
  const body = req.method === "POST" ? await readBody(req) : Buffer.alloc(0);
  const env = gitEnv({
    GIT_PROJECT_ROOT: sidecar.reposDir,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${repoName}.git/${tail}`,
    REQUEST_METHOD: req.method,
    QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    CONTENT_LENGTH: String(body.length),
    REMOTE_USER: "agent",
  });
  if (req.headers["content-encoding"]) {
    env.HTTP_CONTENT_ENCODING = req.headers["content-encoding"];
    env.CONTENT_ENCODING = req.headers["content-encoding"];
  }
  const { code, stdout, stderr } = await runGitBuffer(["http-backend"], { env, input: body });
  if (code !== 0 && stdout.length === 0) {
    sendJson(res, 500, { error: `git http-backend failed: ${stderr.split("\n")[0] ?? code}` });
    return;
  }
  const sep = stdout.indexOf("\r\n\r\n");
  const head = (sep === -1 ? stdout : stdout.subarray(0, sep)).toString("utf8");
  const bodyOut = sep === -1 ? stdout : stdout.subarray(sep + 4);
  let status = 200;
  const headers = {};
  for (const line of head.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key.toLowerCase() === "status") {
      status = parseInt(value, 10) || 200;
    } else {
      headers[key.toLowerCase()] = value;
    }
  }
  res.writeHead(status, headers);
  res.end(bodyOut);
}

export function createSidecarServer(sidecar) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const path = decodeURIComponent(url.pathname);

      const gitMatch = /^(?:\/git)?\/([A-Za-z0-9][A-Za-z0-9._-]*)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch) {
        await handleGitCgi(sidecar, req, res, gitMatch[1], gitMatch[2]);
        return;
      }

      if (path === "/hooks/push" && req.method === "POST") {
        const body = await readJsonBody(req);
        if (!body.repo || !body.ref || !body.after) {
          sendJson(res, 400, { error: "hook push requires repo, ref and after" });
          return;
        }
        const forwarded = await sidecar.forwardPush(body);
        sendJson(res, forwarded.forwarded ? 200 : 202, forwarded);
        return;
      }

      if (path.startsWith("/api/")) {
        if (sidecar.sharedToken) {
          const header = req.headers.authorization ?? "";
          const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
          if (presented !== sidecar.sharedToken) {
            sendJson(res, 401, { error: "sidecar bearer token required" });
            return;
          }
        }

        if (path === "/api/health" && req.method === "GET") {
          sendJson(res, 200, { ok: true, repos: sidecar.listRepos().length });
          return;
        }

        // codex C-1357: Worker-callback deliveries that failed after bounded
        // retries. GET is what the Worker's /status polls; POST is a dev/test
        // helper (like POST /api/repos/:name/commits) to inject a record.
        if (path === "/api/notify-state" && req.method === "GET") {
          sendJson(res, 200, { unprocessed: sidecar.ledger.unprocessed });
          return;
        }
        // Dev/test recovery helper: normal recovery is a successful delivery
        // superseding the record (see forwardPush); this exists for tests and
        // manual cleanup, like POST /api/repos/:name/commits.
        if (path === "/api/notify-state" && req.method === "DELETE") {
          const count = sidecar.ledger.unprocessed.length;
          sidecar.ledger.unprocessed = [];
          sidecar.ledger.save();
          sendJson(res, 200, { cleared: count });
          return;
        }
        if (path === "/api/notify-state" && req.method === "POST") {
          const body = await readJsonBody(req);
          if (!isValidRepoName(body.repo) || !isValidRef(body.ref) || !SHA_RE.test(body.sha ?? "")) {
            sendJson(res, 400, { error: "notify-state inject requires repo, ref and 40-hex sha" });
            return;
          }
          const now = new Date().toISOString();
          const record = sidecar.ledger.record({
            repo: body.repo,
            ref: body.ref,
            sha: body.sha,
            before: body.before ?? null,
            attempts: Number.isInteger(body.attempts) && body.attempts > 0 ? body.attempts : NOTIFY_ATTEMPTS,
            firstAt: now,
            lastAt: now,
            lastError: typeof body.lastError === "string" ? body.lastError : "injected (dev helper)",
          });
          sendJson(res, 201, record);
          return;
        }

        if (path === "/api/repos" && req.method === "POST") {
          const body = await readJsonBody(req);
          const created = await sidecar.createRepo(body.name, {
            defaultBranch: typeof body.defaultBranch === "string" ? body.defaultBranch : "main",
            seedMessage: typeof body.seedMessage === "string" ? body.seedMessage : undefined,
          });
          console.error(`[sidecar] repo created: ${created.name}`);
          sendJson(res, 201, created);
          return;
        }

        if (path === "/api/repos" && req.method === "GET") {
          sendJson(res, 200, { repos: sidecar.listRepos() });
          return;
        }

        const repoMatch = /^\/api\/repos\/([A-Za-z0-9][A-Za-z0-9._-]*)(\/[a-z]+)?$/.exec(path);
        if (repoMatch) {
          const name = repoMatch[1];
          const action = repoMatch[2] ?? "";
          if (req.method === "GET" && action === "" && url.searchParams.get("include") === "full") {
            sendJson(res, 200, { name, remote: sidecar.remoteFor(name) });
            return;
          }
          if (req.method === "DELETE" && action === "") {
            sendJson(res, 200, { deleted: sidecar.deleteRepo(name) });
            return;
          }
          if (req.method === "GET" && action === "/head") {
            sendJson(res, 200, { sha: await sidecar.headCommit(name, url.searchParams.get("ref") ?? "HEAD") });
            return;
          }
          if (req.method === "GET" && action === "/log") {
            const commits = await sidecar.logRepo(name, {
              ref: url.searchParams.get("ref") ?? "HEAD",
              limit: url.searchParams.get("limit"),
              offset: url.searchParams.get("offset"),
            });
            sendJson(res, 200, commits);
            return;
          }
          if (req.method === "GET" && action === "/hascommit") {
            sendJson(res, 200, { known: await sidecar.hasCommit(name, url.searchParams.get("sha") ?? "") });
            return;
          }
          if (req.method === "POST" && action === "/commits") {
            const body = await readJsonBody(req);
            sendJson(res, 201, await sidecar.commitOn(name, { message: body.message, ref: body.ref }));
            return;
          }
          if (req.method === "POST" && action === "/tokens") {
            sidecar.mustRepo(name);
            const body = await readJsonBody(req);
            sendJson(res, 201, sidecar.tokens.mint(name, body.scope, body.ttlSeconds));
            return;
          }
          if (req.method === "POST" && action === "/fork") {
            const body = await readJsonBody(req);
            const forked = await sidecar.forkRepo(name, body.target, {
              baseSha: typeof body.baseSha === "string" ? body.baseSha : undefined,
            });
            console.error(`[sidecar] repo forked: ${name} -> ${forked.name}`);
            sendJson(res, 201, forked);
            return;
          }
        }
      }

      sendJson(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const headers = {};
      const reqUrl = req.url ?? "";
      if (status === 401 && (reqUrl.includes(".git") || reqUrl.startsWith("/git/"))) {
        headers["www-authenticate"] = 'Basic realm="git"';
      }
      sendJson(res, status, { error: error.message ?? "sidecar error" }, headers);
    }
  });
}

/**
 * Start the sidecar. Options: {root, host, port, token, notifyUrl}.
 * Returns {server, port, sidecar, close()}.
 */
export function startSidecar(options = {}) {
  const sidecar = new Sidecar({
    root: options.root,
    token: options.token,
    notifyUrl: options.notifyUrl,
    baseUrl: options.baseUrl,
  });
  const server = createSidecarServer(sidecar);
  return new Promise((resolveStart) => {
    server.listen(options.port ?? 8790, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      sidecar.port = address.port;
      resolveStart({
        server,
        sidecar,
        port: address.port,
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

export async function main() {
  const root = process.env.SIDECAR_ROOT ?? "./.sidecar";
  const host = process.env.SIDECAR_HOST ?? "127.0.0.1";
  const port = Number(process.env.SIDECAR_PORT ?? 8790);
  const token = process.env.SIDECAR_TOKEN ?? null;
  const notifyUrl = process.env.SIDECAR_NOTIFY_URL ?? null;
  const { sidecar } = await startSidecar({ root, host, port, token, notifyUrl });
  console.error(`[sidecar] listening on http://${host}:${port} (root ${sidecar.root})`);
  if (notifyUrl) {
    console.error(`[sidecar] push notifications -> ${notifyUrl}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
