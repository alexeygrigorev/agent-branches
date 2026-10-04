/**
 * Provider-neutral GitHost port (facade extraction, 2026-10-03).
 *
 * The core (src/core/) depends ONLY on these interfaces; Cloudflare is one
 * set of adapters (src/cloudflare/ — the real Artifacts binding), and the
 * local Node sidecar is another (src/local/). Renamed from ArtifactsPort
 * with zero behavioral change: `ArtifactsPort` remains as a deprecated
 * alias so existing imports keep working.
 */

export type RepoName = string;

export type TokenScope = "read" | "write";

export interface CreateRepoOptions {
  description?: string;
  readOnly?: boolean;
  setDefaultBranch?: string;
}

export interface ForkOptions {
  description?: string;
  readOnly?: boolean;
  defaultBranchOnly?: boolean;
  /**
   * Fork starting at this commit of the source's default branch instead of
   * its tip (codex C-1306 base_sha). Local mode realizes it exactly with
   * ordinary git ref updates. The documented Cloudflare binding has no such
   * parameter (docs-notes ASSUMED-F): RealArtifacts forks the default
   * branch and reports the realized base on the ForkResult (muse-r46 D3).
   */
  baseSha?: string;
}

export interface ArtifactsCreateRepoResult {
  name: RepoName;
  remote: string;
  defaultBranch: string;
  token: string;
}

/**
 * Port-level fork result: the documented binding result plus, when
 * ForkOptions.baseSha was requested, the commit the fork ACTUALLY starts at
 * (muse-r46 D3). Implementations that honor baseSha exactly (local sidecar)
 * may omit it; RealArtifacts reports the fork's head at creation
 * (docs-notes ASSUMED-F) so the coordinator records the real base.
 */
export interface ForkResult extends ArtifactsCreateRepoResult {
  baseSha?: string;
}

export interface ArtifactsTokenResult {
  plaintext: string;
  expiresAt: string;
  scope: TokenScope;
}

export interface GitAuthor {
  name: string;
  email: string;
}

export interface CommitMetadata {
  id: string;
  message: string;
  timestamp: string;
  parents: string[];
  author?: GitAuthor;
  committer?: GitAuthor;
}

export interface LogOptions {
  ref?: string;
  limit?: number;
  offset?: number;
}

/**
 * Local-mode callback guard (codex C-1357): a push whose post-receive
 * callback to the Worker failed auth/delivery after the sidecar's bounded
 * retries. The Worker never accepted it, so the agent's true head is
 * unknown until a later successful delivery supersedes the record.
 */
export interface UnprocessedPush {
  repo: RepoName;
  ref: string;
  sha: string;
  before: string | null;
  attempts: number;
  firstAt: string;
  lastAt: string;
  lastError: string;
}

export interface RepoSummary {
  name: RepoName;
  status: "ready" | "importing" | "forking";
}

/**
 * Git hosting operations the coordinator needs, independent of any provider.
 * Implementations: src/cloudflare/githost.ts (real Artifacts binding,
 * src/artifacts/real.ts) and src/local/githost.ts (local git sidecar).
 */
export interface GitHost {
  createRepo(name: RepoName, opts?: CreateRepoOptions): Promise<ArtifactsCreateRepoResult>;

  fork(source: RepoName, target: RepoName, opts?: ForkOptions): Promise<ForkResult>;

  mintToken(
    repo: RepoName,
    scope?: TokenScope,
    ttlSeconds?: number,
  ): Promise<ArtifactsTokenResult>;

  log(repo: RepoName, opts?: LogOptions): Promise<CommitMetadata[]>;

  /**
   * Tip commit id of a ref (default HEAD). Derived ONLY from the documented
   * `log({ ref, limit: 1 })` operation — there is no documented binding API
   * that enumerates refs (codex C-1305 #2), so the port deliberately does
   * not offer ref enumeration; ref state must be tracked from push events.
   */
  headCommit(repo: RepoName, ref?: string): Promise<string | null>;

  hasCommit(repo: RepoName, sha: string): Promise<boolean>;

  listRepos(limit?: number): Promise<RepoSummary[]>;

  deleteRepo(name: RepoName): Promise<boolean>;

  /**
   * Pushes whose Worker callback was lost (codex C-1357). OPTIONAL and
   * local-mode only: the sidecar keeps the durable ledger
   * (GET /api/notify-state); the documented real binding has its own event
   * subscription, so RealArtifacts returns [] (ASSUMED-G: a real deployment
   * surfaces delivery failures through the subscription, not this port).
   */
  unprocessedPushes?(): Promise<UnprocessedPush[]>;
}

/** Deprecated alias: the pre-facade name of GitHost (no behavior change). */
export type ArtifactsPort = GitHost;
