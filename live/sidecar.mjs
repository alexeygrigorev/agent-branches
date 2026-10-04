#!/usr/bin/env node
// Local-artifacts git sidecar for the Agent Branches live run.
//
// Stands in for Cloudflare Artifacts repos: real bare git repositories on disk,
// served over the git smart HTTP protocol so plain `git clone/push` works, plus
// a small JSON API that mirrors the documented Artifacts surface (create, fork,
// tokens, refs, log, hasCommit) for the Worker's SidecarArtifacts port.
//
// Auth: /api/* requires ADMIN_TOKEN (writes) or RUNNER_TOKEN (reads).
// git pushes to /git/<repo>.git require that repo's minted write token.
// No deps: node stdlib only. Run: node live/sidecar.mjs

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const PORT = Number(process.env.SIDECAR_PORT || 8799);
const HOST = "127.0.0.1";
const ARTIFACTS_ROOT = path.resolve(process.env.ARTIFACTS_ROOT || "live/artifacts");
const STATE_FILE = path.join(ARTIFACTS_ROOT, ".sidecar-state.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || "";

fs.mkdirSync(ARTIFACTS_ROOT, { recursive: true });

/** @type {Map<string, {tokens: Array<{id:string,scope:string,expiresAt:string,plaintext:string}>}>} */
const state = new Map();
try {
  for (const [name, repo] of Object.entries(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")))) {
    state.set(name, repo);
  }
} catch {
  /* first run */
}

function persistState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(state), null, 2));
}

function hex(n) {
  return crypto.randomBytes(n).toString("hex").slice(0, n * 2);
}

function repoPath(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid repo name: ${name}`);
  return path.join(ARTIFACTS_ROOT, `${name}.git`);
}

function git(args, opts = {}) {
  const res = spawnSync("git", args, { encoding: "utf8", ...opts });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function mintToken(repoName, scope = "write", ttlSeconds = 3600) {
  const repo = state.get(repoName);
  if (!repo) throw new Error(`repo not found: ${repoName}`);
  const expiresUnix = Math.floor(Date.now() / 1000) + ttlSeconds;
  const secret = hex(20);
  const token = {
    id: hex(8),
    scope,
    expiresAt: new Date(expiresUnix * 1000).toISOString(),
    plaintext: `art_v1_${secret}?expires=${expiresUnix}`,
  };
  repo.tokens.push(token);
  persistState();
  return token;
}

function createRepo(name, opts = {}) {
  if (state.has(name)) throw new Error(`repo already exists: ${name}`);
  const defaultBranch = opts.setDefaultBranch || "main";
  git(["init", "--bare", "--initial-branch", defaultBranch, repoPath(name)]);
  git(["-C", repoPath(name), "config", "http.receivepack", "true"]);
  git(["-C", repoPath(name), "config", "http.uploadpack", "true"]);
  state.set(name, { tokens: [], defaultBranch });
  persistState();
  return { name, remote: remoteFor(name), defaultBranch, token: mintToken(name).plaintext };
}

function fork(source, target) {
  const src = state.get(source);
  if (!src) throw new Error(`repo not found: ${source}`);
  if (state.has(target)) throw new Error(`repo already exists: ${target}`);
  git(["clone", "--bare", repoPath(source), repoPath(target)]);
  git(["-C", repoPath(target), "config", "http.receivepack", "true"]);
  state.set(target, { tokens: [], defaultBranch: src.defaultBranch });
  persistState();
  return { name: target, remote: remoteFor(target), defaultBranch: src.defaultBranch, token: mintToken(target).plaintext };
}

function remoteFor(name) {
  return `http://${HOST}:${PORT}/git/${name}.git`;
}

function listRefs(name) {
  const out = git(["-C", repoPath(name), "for-each-ref", "--format=%(refname) %(objectname)"]);
  const refs = {};
  for (const line of out.split("\n")) {
    const [ref, sha] = line.trim().split(/\s+/);
    if (ref && sha) refs[ref] = sha;
  }
  return refs;
}

function log(name, { ref = "HEAD", limit = 50 } = {}) {
  const out = git([
    "-C", repoPath(name), "log", `--max-count=${limit}`, "--date=iso-strict",
    "--format=%H%x1f%s%x1f%aI%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce", ref,
  ]).trim();
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [id, message, timestamp, parents, an, ae, cn, ce] = line.split("\x1f");
    return {
      id,
      message,
      timestamp,
      parents: parents ? parents.split(" ") : [],
      author: { name: an, email: ae },
      committer: { name: cn, email: ce },
    };
  });
}

function hasCommit(name, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return false;
  const res = spawnSync("git", ["-C", repoPath(name), "cat-file", "-e", `${sha}^{commit}`]);
  return res.status === 0;
}

// ---------- auth ----------

function bearer(req) {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || "");
  return m ? m[1] : null;
}

function requireApiAuth(req, write) {
  const token = bearer(req);
  if (!token) throw HttpError(401, "missing bearer token");
  if (write) {
    if (token !== ADMIN_TOKEN) throw HttpError(403, "admin token required");
  } else if (token !== ADMIN_TOKEN && token !== RUNNER_TOKEN) {
    throw HttpError(403, "valid token required");
  }
}

/** git pushes must present a live write token minted for that repo. */
function requirePushAuth(req, repoName) {
  const token = bearer(req);
  if (!token) throw HttpError(401, "push requires a write token");
  const repo = state.get(repoName);
  const rec = repo?.tokens.find((t) => t.plaintext === token);
  if (!rec) throw HttpError(403, `token not valid for ${repoName}`);
  if (rec.scope !== "write") throw HttpError(403, "token scope is read-only");
  if (new Date(rec.expiresAt).getTime() < Date.now()) throw HttpError(403, "token expired");
}

function HttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------- git smart HTTP ----------

function runGitBackend(req, res, pathname, query, body) {
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: ARTIFACTS_ROOT,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: pathname,
    REQUEST_METHOD: req.method,
    QUERY_STRING: query,
    REMOTE_ADDR: req.socket.remoteAddress || "127.0.0.1",
    CONTENT_TYPE: req.headers["content-type"] || "",
    CONTENT_LENGTH: String(body.length),
  };
  if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = req.headers["content-encoding"];
  if (req.headers.accept) env.HTTP_ACCEPT = req.headers.accept;

  const cgi = spawn("git", ["http-backend"], { env });
  const stdout = [];
  let stderr = "";
  cgi.stdout.on("data", (d) => stdout.push(d));
  cgi.stderr.on("data", (d) => (stderr += d));
  cgi.on("close", (code) => {
    const raw = Buffer.concat(stdout);
    if (code !== 0 && raw.length === 0) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`git http-backend failed: ${stderr}`);
      return;
    }
    const sep = raw.indexOf("\r\n\r\n");
    const headText = raw.subarray(0, sep).toString();
    const payload = raw.subarray(sep + 4);
    const headers = {};
    let status = 200;
    for (const line of headText.split("\r\n")) {
      const [k, v] = line.split(/:\s*/);
      if (/^status$/i.test(k)) status = Number(v.split(/\s+/)[1]) || 200;
      else headers[k.toLowerCase()] = v;
    }
    if (!headers["content-type"]) headers["content-type"] = "application/octet-stream";
    res.writeHead(status, headers);
    res.end(payload);
  });
  cgi.stdin.end(body);
}

// ---------- server ----------

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    const body = await readBody(req);

    // ---- git smart HTTP ----
    const gitMatch = /^\/git\/([A-Za-z0-9._-]+)\.git(\/.*)$/.exec(url.pathname);
    if (gitMatch) {
      const [, repoName, op] = gitMatch;
      if (!state.has(repoName)) throw HttpError(404, `repo not found: ${repoName}`);
      const isReceive =
        (op === "/info/refs" && url.searchParams.get("service") === "git-receive-pack") ||
        op === "/git-receive-pack";
      if (isReceive) requirePushAuth(req, repoName);
      runGitBackend(req, res, `/${repoName}.git${op}`, url.search, body);
      return;
    }

    // ---- JSON API ----
    if (url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, repos: [...state.keys()] });
    }
    if (url.pathname === "/api/repos" && req.method === "GET") {
      requireApiAuth(req, false);
      return sendJson(res, 200, { repos: [...state.keys()].map((name) => ({ name, status: "ready" })) });
    }
    if (url.pathname === "/api/repos" && req.method === "POST") {
      requireApiAuth(req, true);
      const payload = JSON.parse(body.toString() || "{}");
      return sendJson(res, 201, createRepo(payload.name, payload));
    }
    const forkMatch = /^\/api\/repos\/([^/]+)\/fork$/.exec(url.pathname);
    if (forkMatch && req.method === "POST") {
      requireApiAuth(req, true);
      const payload = JSON.parse(body.toString() || "{}");
      return sendJson(res, 201, fork(forkMatch[1], payload.target));
    }
    const tokenMatch = /^\/api\/repos\/([^/]+)\/tokens$/.exec(url.pathname);
    if (tokenMatch && req.method === "POST") {
      requireApiAuth(req, true);
      const payload = JSON.parse(body.toString() || "{}");
      const token = mintToken(tokenMatch[1], payload.scope || "write", payload.ttlSeconds || 3600);
      return sendJson(res, 201, { plaintext: token.plaintext, expiresAt: token.expiresAt, scope: token.scope });
    }
    const refsMatch = /^\/api\/repos\/([^/]+)\/refs$/.exec(url.pathname);
    if (refsMatch && req.method === "GET") {
      requireApiAuth(req, false);
      return sendJson(res, 200, listRefs(refsMatch[1]));
    }
    const logMatch = /^\/api\/repos\/([^/]+)\/log$/.exec(url.pathname);
    if (logMatch && req.method === "GET") {
      requireApiAuth(req, false);
      return sendJson(res, 200, log(logMatch[1], {
        ref: url.searchParams.get("ref") || "HEAD",
        limit: Number(url.searchParams.get("limit") || 50),
      }));
    }
    const commitMatch = /^\/api\/repos\/([^/]+)\/has-commit\/([0-9a-f]{40})$/.exec(url.pathname);
    if (commitMatch && req.method === "GET") {
      requireApiAuth(req, false);
      return sendJson(res, 200, { exists: hasCommit(commitMatch[1], commitMatch[2]) });
    }
    const delMatch = /^\/api\/repos\/([^/]+)$/.exec(url.pathname);
    if (delMatch && req.method === "DELETE") {
      requireApiAuth(req, true);
      const existed = state.delete(delMatch[1]);
      if (existed) fs.rmSync(repoPath(delMatch[1]), { recursive: true, force: true });
      persistState();
      return sendJson(res, 200, { deleted: existed });
    }

    throw HttpError(404, `no route for ${req.method} ${url.pathname}`);
  } catch (err) {
    const status = err.status || 500;
    sendJson(res, status, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`sidecar listening on http://${HOST}:${PORT} root=${ARTIFACTS_ROOT}`);
});
