/**
 * Thin Artifacts REST client for OUTSIDE-the-Worker operations
 * (PLAN-L1-REAL §1 decision: "add a thin REST client ONLY for the bootstrap
 * script … Do not port the whole port to REST").
 *
 * Why it exists (spike finding 6, CONFIRMED): wrangler 4.147.0 has
 * `artifacts namespaces|repos list/get` subcommands but NO namespace-create
 * and NO fork command — namespace/repo creation and forking from scripts go
 * through REST. Inside the Worker, the binding (src/artifacts/real.ts)
 * covers the same operations. Both paths share the error mapping
 * (src/artifacts/errors.ts) and the commit/repo mappers (src/artifacts/map.ts).
 *
 * All shapes below are fixtures-validated against the real service
 * (artifacts-spike @ c75faa1, appendix-transcript.md): Cloudflare envelope
 * `{result, success, errors, messages}`, snake_case REST fields
 * (`expires_at`, `default_branch`), epoch-seconds commit instants, `status`
 * on LIST only, tokens opaque (`art_v2_x_…?expires=…`).
 *
 * OFFLINE by construction in tests: `fetch` is injectable; no test touches
 * the network and no credential is read here.
 */

import {
  ArtifactsError,
  ArtifactsNotFoundError,
  mapRestError,
} from "./errors.js";
import type { RawCommit, RawRepo } from "./map.js";

export interface ArtifactsRestConfig {
  accountId: string;
  apiToken: string;
  /** Default: https://api.cloudflare.com/client/v4 */
  baseUrl?: string;
  /** Injectable for offline tests. */
  fetch?: typeof fetch;
}

export interface RestNamespace {
  namespace: string;
  jurisdiction: string;
  repo_count: number;
  created_at: string;
  updated_at: string;
}

/** Raw REST token mint/list shape (spike O5/O22) — snake_case on REST. */
export interface RestTokenInfo {
  id: string;
  /** createToken only — the plaintext is returned exactly once, never logged. */
  plaintext?: string;
  scope: "read" | "write";
  state?: "active" | "revoked";
  expires_at: string;
}

export interface RestCreateRepoOptions {
  description?: string;
  read_only?: boolean;
}

export interface RestForkOptions {
  description?: string;
  read_only?: boolean;
  /** Fork the source's default branch only (spike F CONFIRMED — the only mode). */
  default_branch_only?: boolean;
}

export interface RestListOptions {
  limit?: number;
  sort?: "name";
}

export interface RestLogOptions {
  ref?: string;
  limit?: number;
}

interface CloudflareEnvelope<T> {
  result: T;
  success: boolean;
  errors: { code: number; message: string }[];
  messages: unknown[];
  result_info?: { page: number; per_page: number; total_pages: number; count: number; total_count: number };
}

export const DEFAULT_ARTIFACTS_REST_BASE = "https://api.cloudflare.com/client/v4";

export class ArtifactsRestClient {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ArtifactsRestConfig) {
    this.accountId = config.accountId;
    this.apiToken = config.apiToken;
    this.baseUrl = (config.baseUrl ?? DEFAULT_ARTIFACTS_REST_BASE).replace(/\/$/, "");
    this.fetchImpl = config.fetch ?? fetch.bind(globalThis);
  }

  private url(path: string, query: Record<string, string | number | undefined> = {}): string {
    // The apiToken NEVER appears in the URL — Bearer header only.
    const url = new URL(`${this.baseUrl}/accounts/${this.accountId}/artifacts${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request<T>(method: string, path: string, query?: Record<string, string | number | undefined>, body?: unknown): Promise<CloudflareEnvelope<T>> {
    const response = await this.fetchImpl(this.url(path, query), {
      method,
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    const envelope = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Partial<CloudflareEnvelope<T>>;
    if (!response.ok || envelope.success === false) {
      throw mapRestError(response.status, parsed);
    }
    return envelope as CloudflareEnvelope<T>;
  }

  // --- namespaces (wrangler has list/get only; create is REST/binding) ---

  async getNamespace(name: string): Promise<RestNamespace | null> {
    try {
      const envelope = await this.request<RestNamespace>("GET", `/namespaces/${encodeURIComponent(name)}`);
      return envelope.result;
    } catch (err) {
      if (err instanceof ArtifactsNotFoundError) {
        return null; // 404 + code 10200 (spike O1)
      }
      throw err;
    }
  }

  async createNamespace(name: string): Promise<RestNamespace> {
    const envelope = await this.request<RestNamespace>("POST", `/namespaces`, undefined, { namespace: name });
    return envelope.result;
  }

  /** Idempotent bootstrap helper (PLAN-L1-REAL §6 step 2). */
  async ensureNamespace(name: string): Promise<{ namespace: RestNamespace; created: boolean }> {
    const existing = await this.getNamespace(name);
    if (existing !== null) {
      return { namespace: existing, created: false };
    }
    return { namespace: await this.createNamespace(name), created: true };
  }

  // --- repos ---

  async createRepo(namespace: string, name: string, opts?: RestCreateRepoOptions): Promise<RawRepo> {
    const envelope = await this.request<RawRepo>(
      "POST",
      `/namespaces/${encodeURIComponent(namespace)}/repos`,
      undefined,
      { name, ...opts },
    );
    return envelope.result;
  }

  /**
   * Single GET — the result has NO `status` field (spike finding 2), so this
   * method must never be used to decide readiness; use `listRepos`.
   */
  async getRepo(namespace: string, name: string): Promise<RawRepo | null> {
    try {
      const envelope = await this.request<RawRepo>(
        "GET",
        `/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(name)}`,
      );
      return envelope.result;
    } catch (err) {
      if (err instanceof ArtifactsNotFoundError) {
        return null;
      }
      throw err;
    }
  }

  /** LIST carries `status` ("ready" | "importing" | "forking", spike O17). */
  async listRepos(namespace: string, opts: RestListOptions = {}): Promise<RawRepo[]> {
    const envelope = await this.request<RawRepo[]>(
      "GET",
      `/namespaces/${encodeURIComponent(namespace)}/repos`,
      { limit: opts.limit ?? 50, sort: opts.sort },
    );
    return envelope.result;
  }

  /** REST-only in wrangler terms: no `wrangler artifacts … fork` exists. */
  async fork(namespace: string, source: string, target: string, opts?: RestForkOptions): Promise<RawRepo> {
    const envelope = await this.request<RawRepo>(
      "POST",
      `/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(source)}/fork`,
      undefined,
      { name: target, ...opts },
    );
    return envelope.result;
  }

  async deleteRepo(namespace: string, name: string): Promise<boolean> {
    // Documented as 202; treat any success envelope as accepted.
    await this.request<unknown>(
      "DELETE",
      `/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(name)}`,
    );
    return true;
  }

  // --- tokens (REST: snake_case expires_at; plaintext only on mint, O5) ---

  async mintToken(
    namespace: string,
    repo: string,
    scope: "read" | "write",
    ttlSeconds: number,
  ): Promise<RestTokenInfo> {
    const envelope = await this.request<RestTokenInfo>(
      "POST",
      `/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(repo)}/tokens`,
      undefined,
      { scope, ttl: ttlSeconds },
    );
    return envelope.result;
  }

  async listTokens(namespace: string, repo: string, state: "active" | "all" = "active"): Promise<RestTokenInfo[]> {
    const envelope = await this.request<RestTokenInfo[]>(
      "GET",
      `/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(repo)}/tokens`,
      { state },
    );
    return envelope.result;
  }

  async revokeToken(namespace: string, repo: string, tokenId: string): Promise<boolean> {
    await this.request<{ id: string }>(
      "DELETE",
      `/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(repo)}/tokens/${encodeURIComponent(tokenId)}`,
    );
    return true;
  }

  // --- git data-plane reads over REST ---

  /**
   * RAW commits (hash + epoch-seconds instants, spike O13/O16). Map to port
   * CommitMetadata with mapRawCommit() at the consumer boundary — never read
   * `.id`/`.timestamp` off these.
   */
  async log(namespace: string, repo: string, opts: RestLogOptions = {}): Promise<RawCommit[]> {
    const envelope = await this.request<RawCommit[]>(
      "GET",
      `/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(repo)}/log`,
      { ref: opts.ref ?? "HEAD", limit: opts.limit ?? 50 },
    );
    return envelope.result;
  }
}

export { ArtifactsError, ArtifactsNotFoundError };
