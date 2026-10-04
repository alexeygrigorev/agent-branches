import type {
  ArtifactsCreateRepoResult,
  ArtifactsPort,
  ArtifactsTokenResult,
  CommitMetadata,
  CreateRepoOptions,
  ForkOptions,
  ForkResult,
  LogOptions,
  RepoName,
  RepoSummary,
  TokenScope,
  UnprocessedPush,
} from "../types.js";
import {
  ArtifactsForkNotReadyError,
  normalizeArtifactsError,
  type ArtifactsError,
} from "./errors.js";
import { mapRawCommit, mapRawRepoSummary, type RawCommit } from "./map.js";

/**
 * REALITY notes (artifacts-spike, origin/proto/artifacts-spike @ c75faa1):
 *
 * - Commit fields over the real service are `{hash, treeHash, message,
 *   author, committer, parents[], authoredAt, committedAt}` with
 *   EPOCH-SECONDS instants — never `.id`/ISO `.timestamp` (finding B, REST
 *   evidence O13/O16). The capability below therefore exposes the RAW shape
 *   and RealArtifacts maps to port CommitMetadata at exactly one boundary
 *   (src/artifacts/map.ts). Binding type generation (`npx wrangler types`)
 *   is still UNVERIFIED — D stays open — but nothing here may assume the
 *   old id/ISO shape again.
 * - Tokens are OPAQUE. The real service issues `art_v2_x_<40
 *   hex>?expires=<unix>`, not the documented `art_v1_…` (finding 1): this
 *   adapter never validates, normalizes or trims a token string.
 * - Fork is default-branch only (F CONFIRMED, O9/O10/O13). Readiness is
 *   polled from the LIST response's `status` field — the ONLY place it
 *   exists (finding 2: single GET has no status) — with bounded retries.
 *   `last_push_at` stays null forever (finding 3) and is never consulted.
 * - Namespace creation and forks are REST/binding-only: the wrangler CLI
 *   has list/get subcommands but NO create/fork (finding 6). The Worker
 *   path uses the binding; the bootstrap script path uses
 *   src/artifacts/rest.ts (PLAN-L1-REAL §1).
 */

export interface ArtifactsRepoCapability {
  info(): Promise<{
    name: RepoName;
    defaultBranch: string;
    description: string | null;
    readOnly: boolean;
  }>;
  createToken(scope?: TokenScope, ttl?: number): Promise<ArtifactsTokenResult>;
  listTokens(): Promise<{ total: number; tokens: unknown[] }>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  fork(name: RepoName, opts?: ForkOptions): Promise<ArtifactsCreateRepoResult>;
  /** RAW real-service shape (hash/epoch seconds) — mapped at the port boundary. */
  log(opts?: LogOptions): Promise<RawCommit[]>;
  readCommit(hash: string): Promise<RawCommit | null>;
  readTree(hash: string): Promise<{ mode: string; type: string; name: string; hash: string }[] | null>;
  readBlob(hash: string): Promise<Blob | null>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
  [Symbol.dispose](): void;
}

/** Raw LIST entry: `status` is present on real LIST responses (O17). */
export interface RawRepoListEntry {
  name: RepoName;
  status?: string;
}

export interface ArtifactsNamespaceBinding {
  create(name: RepoName, opts?: CreateRepoOptions): Promise<ArtifactsCreateRepoResult>;
  get(name: RepoName): Promise<ArtifactsRepoCapability>;
  list(opts?: { limit?: number; cursor?: string }): Promise<{
    repos: RawRepoListEntry[];
    cursor?: string;
  }>;
  import(params: {
    source: { url: string; branch?: string; depth?: number };
    target: { name: RepoName; opts?: CreateRepoOptions };
  }): Promise<ArtifactsCreateRepoResult>;
  delete(name: RepoName): Promise<boolean>;
}

export interface RealArtifactsOptions {
  /**
   * Fork-readiness polling (spike: forks observed ready within ~2–4.5 s,
   * O9–O12). Defaults: 20 attempts × 500 ms.
   */
  readiness?: {
    maxAttempts?: number;
    delayMs?: number;
  };
  /** Injectable sleeper for tests; default a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_READINESS_ATTEMPTS = 20;
const DEFAULT_READINESS_DELAY_MS = 500;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RealArtifacts implements ArtifactsPort {
  private readonly binding: ArtifactsNamespaceBinding;
  private readonly readinessMaxAttempts: number;
  private readonly readinessDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(binding: ArtifactsNamespaceBinding, options: RealArtifactsOptions = {}) {
    this.binding = binding;
    this.readinessMaxAttempts = options.readiness?.maxAttempts ?? DEFAULT_READINESS_ATTEMPTS;
    this.readinessDelayMs = options.readiness?.delayMs ?? DEFAULT_READINESS_DELAY_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Error boundary for binding calls: the real binding's thrown shape is
   * UNVERIFIED (spike ASSUMED-D), so normalize only what carries
   * recognizable markers (status/code/envelope) and pass anything else
   * through untouched.
   */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const normalized = normalizeArtifactsError(err) as ArtifactsError | unknown;
      if (normalized instanceof Error && normalized !== err) {
        throw normalized;
      }
      throw err;
    }
  }

  async createRepo(name: RepoName, opts?: CreateRepoOptions): Promise<ArtifactsCreateRepoResult> {
    return this.guarded(() => this.binding.create(name, opts));
  }

  async fork(source: RepoName, target: RepoName, opts?: ForkOptions): Promise<ForkResult> {
    // muse-r46 D3 + spike F (CONFIRMED): the real service can only fork the
    // source's DEFAULT branch — there is no fork-at-commit parameter. Strip
    // baseSha (it would be silently ignored anyway), fork, then REPORT the
    // realized base (the fork's head at creation) so the coordinator records
    // the truth.
    const { baseSha, ...bindingOpts } = opts ?? {};
    using repo = await this.guarded(() => this.binding.get(source));
    const created = await this.guarded(() =>
      repo.fork(target, Object.keys(bindingOpts).length > 0 ? bindingOpts : undefined),
    );
    // Readiness (finding 2): poll the LIST status — single GET has no status
    // field and last_push_at is always null, so neither may decide readiness.
    await this.waitForRepoReady(created.name);
    if (baseSha === undefined) {
      return created;
    }
    using fresh = await this.guarded(() => this.binding.get(created.name));
    const head = await this.guarded(() => fresh.log({ limit: 1 }));
    const realized = head.length > 0 ? mapRawCommit(head[0]).id : null;
    return { ...created, baseSha: realized ?? baseSha };
  }

  /**
   * Bounded readiness poll against the LIST response (the only surface that
   * carries `status`). A repo that never appears or never reaches "ready"
   * throws ArtifactsForkNotReadyError after `readinessMaxAttempts` polls.
   */
  async waitForRepoReady(name: RepoName): Promise<void> {
    for (let attempt = 1; attempt <= this.readinessMaxAttempts; attempt += 1) {
      const page = await this.guarded(() => this.binding.list({ limit: 100 }));
      const entry: RawRepoListEntry | undefined = page.repos.find((repo) => repo.name === name);
      if (entry !== undefined && mapRawRepoSummary(entry).status === "ready") {
        return;
      }
      if (attempt < this.readinessMaxAttempts) {
        await this.sleep(this.readinessDelayMs);
      }
    }
    throw new ArtifactsForkNotReadyError(this.readinessMaxAttempts);
  }

  async mintToken(
    repo: RepoName,
    scope: TokenScope = "write",
    ttlSeconds = 3600,
  ): Promise<ArtifactsTokenResult> {
    // Opaque passthrough: real tokens look like
    // `art_v2_x_<40hex>?expires=<unix>`; no prefix validation anywhere.
    using handle = await this.guarded(() => this.binding.get(repo));
    return this.guarded(() => handle.createToken(scope, ttlSeconds));
  }

  async log(repo: RepoName, opts?: LogOptions): Promise<CommitMetadata[]> {
    using handle = await this.guarded(() => this.binding.get(repo));
    const raw = await this.guarded(() => handle.log(opts));
    return raw.map(mapRawCommit);
  }

  async headCommit(repo: RepoName, ref = "HEAD"): Promise<string | null> {
    using handle = await this.guarded(() => this.binding.get(repo));
    // Only documented operation: log({ref, limit:1}) yields the tip commit
    // (no refs-enumeration API exists — ASSUMED-A, spike-CONFIRMED).
    const commits = await this.guarded(() => handle.log({ ref, limit: 1 }));
    return commits.length > 0 ? mapRawCommit(commits[0]).id : null;
  }

  async hasCommit(repo: RepoName, sha: string): Promise<boolean> {
    using handle = await this.guarded(() => this.binding.get(repo));
    return (await this.guarded(() => handle.readCommit(sha))) !== null;
  }

  async listRepos(limit = 100): Promise<RepoSummary[]> {
    const page = await this.guarded(() => this.binding.list({ limit }));
    return page.repos.map(mapRawRepoSummary);
  }

  async deleteRepo(name: RepoName): Promise<boolean> {
    return this.guarded(() => this.binding.delete(name));
  }

  /**
   * codex C-1357: the callback-loss ledger is a LOCAL sidecar mechanism. A
   * real deployment gets push events (and their delivery state) from the
   * Artifacts event subscription itself, so there is nothing to report here
   * (docs-notes ASSUMED-G; subscription wiring itself is UNVERIFIED — E).
   */
  async unprocessedPushes(): Promise<UnprocessedPush[]> {
    return [];
  }
}
