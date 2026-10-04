/**
 * Local-mode GitHost adapter backed by the Node git sidecar (codex
 * C-1309 #7a): real bare git repos on disk, reached over fetch. The
 * coordinator performs no git operations itself — forks are
 * `git clone --bare`, pushes happen with ordinary `git push` against the
 * sidecar's smart HTTP endpoint. Moved here from src/artifacts/sidecar.ts
 * by the facade extraction (the old path keeps a re-export shim); the only
 * change is the injectable `FetchLike` boundary so this adapter also
 * typechecks without workers-types in the Node build.
 */

import type {
  ArtifactsCreateRepoResult,
  ArtifactsTokenResult,
  CommitMetadata,
  CreateRepoOptions,
  ForkOptions,
  ForkResult,
  GitHost,
  LogOptions,
  RepoName,
  RepoSummary,
  TokenScope,
  UnprocessedPush,
} from "../ports/githost.js";

/** The one fetch call shape this adapter makes (node http client or workerd). */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function globalFetch(): FetchLike {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) {
    throw new Error("no fetch implementation available (sidecar GitHost requires fetch)");
  }
  return f.bind(globalThis);
}

export class SidecarArtifacts implements GitHost {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly doFetch: FetchLike;

  constructor(baseUrl: string, token?: string, fetchImpl?: FetchLike) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.doFetch = fetchImpl ?? globalFetch();
  }

  private async call(path: string, init?: { method?: string; body?: string }): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    const res = await this.doFetch(`${this.baseUrl}${path}`, { ...init, headers });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      throw new Error(body.error ?? `sidecar ${path} failed: HTTP ${res.status}`);
    }
    return body;
  }

  async createRepo(name: RepoName, opts?: CreateRepoOptions): Promise<ArtifactsCreateRepoResult> {
    const body = (await this.call("/api/repos", {
      method: "POST",
      body: JSON.stringify({ name, defaultBranch: opts?.setDefaultBranch }),
    })) as ArtifactsCreateRepoResult;
    return { name: body.name, remote: body.remote, defaultBranch: body.defaultBranch, token: body.token };
  }

  async fork(source: RepoName, target: RepoName, opts?: ForkOptions): Promise<ForkResult> {
    const body = (await this.call(`/api/repos/${encodeURIComponent(source)}/fork`, {
      method: "POST",
      body: JSON.stringify({ target, baseSha: opts?.baseSha }),
    })) as ArtifactsCreateRepoResult;
    // Local mode honors baseSha exactly (git update-ref after bare clone),
    // so the realized base is the requested one; no marker needed.
    return { name: body.name, remote: body.remote, defaultBranch: body.defaultBranch, token: body.token };
  }

  async mintToken(repo: RepoName, scope: TokenScope = "write", ttlSeconds = 3600): Promise<ArtifactsTokenResult> {
    return (await this.call(`/api/repos/${encodeURIComponent(repo)}/tokens`, {
      method: "POST",
      body: JSON.stringify({ scope, ttlSeconds }),
    })) as ArtifactsTokenResult;
  }

  async log(repo: RepoName, opts?: LogOptions): Promise<CommitMetadata[]> {
    const params = new URLSearchParams();
    params.set("ref", opts?.ref ?? "HEAD");
    params.set("limit", String(opts?.limit ?? 50));
    params.set("offset", String(opts?.offset ?? 0));
    return (await this.call(`/api/repos/${encodeURIComponent(repo)}/log?${params}`)) as CommitMetadata[];
  }

  async headCommit(repo: RepoName, ref = "HEAD"): Promise<string | null> {
    const body = (await this.call(
      `/api/repos/${encodeURIComponent(repo)}/head?ref=${encodeURIComponent(ref)}`,
    )) as { sha: string | null };
    return body.sha;
  }

  async hasCommit(repo: RepoName, sha: string): Promise<boolean> {
    const body = (await this.call(
      `/api/repos/${encodeURIComponent(repo)}/hascommit?sha=${encodeURIComponent(sha)}`,
    )) as { known: boolean };
    return body.known;
  }

  async listRepos(limit = 100): Promise<RepoSummary[]> {
    const body = (await this.call(`/api/repos?limit=${limit}`)) as { repos: RepoSummary[] };
    return body.repos.slice(0, limit);
  }

  async deleteRepo(name: RepoName): Promise<boolean> {
    const body = (await this.call(`/api/repos/${encodeURIComponent(name)}`, { method: "DELETE" })) as {
      deleted: boolean;
    };
    return body.deleted;
  }

  /** Pushes whose Worker callback failed after bounded retries (C-1357). */
  async unprocessedPushes(): Promise<UnprocessedPush[]> {
    const body = (await this.call("/api/notify-state")) as { unprocessed: UnprocessedPush[] };
    return body.unprocessed;
  }
}
