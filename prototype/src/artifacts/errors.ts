/**
 * Typed Artifacts errors mapped from the REAL service behavior observed in
 * the artifacts-spike (origin/proto/artifacts-spike @ c75faa1, RESULTS.md).
 *
 * Confirmed mappings (spike evidence):
 * - Namespace/repo not found: HTTP 404 with Cloudflare error code 10200
 *   "Namespace not found" (O1). Same numeric family as the docs' examples.
 * - A read-scope token pushing to receive-pack is rejected with **HTTP 400**,
 *   NOT 401/403, and fails fast (~52 ms) with nothing written (O27). Error
 *   mapping must therefore treat a 4xx on push as an auth/scope failure.
 * - Documented `art_v1_…` token prefix is wrong; the real service issues
 *   `art_v2_x_<40 hex>?expires=<unix>` (finding 1). Tokens are OPAQUE here:
 *   no code validates, normalizes or trims token strings.
 */

/** Cloudflare service error codes observed against the real Artifacts API. */
export const ARTIFACTS_ERROR_CODES = {
  /** 404 "Namespace not found" (spike O1); same family for missing repos. */
  notFound: 10200,
} as const;

export interface ArtifactsErrorOptions {
  /** HTTP status when the error crossed REST or git smart HTTP. */
  status?: number;
  /** Cloudflare numeric error code from the REST envelope, when present. */
  serviceCode?: number;
  cause?: unknown;
}

export class ArtifactsError extends Error {
  readonly status?: number;
  readonly serviceCode?: number;

  constructor(message: string, options: ArtifactsErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.serviceCode = options.serviceCode;
  }
}

/** 404 + code 10200 (or an equivalent strict lookup miss) on the real API. */
export class ArtifactsNotFoundError extends ArtifactsError {}

/**
 * Token auth/scope failure on the git data plane. The real service rejects a
 * read-scope push with HTTP **400** (spike O27) — not 401/403 — so callers
 * must not branch on 401/403 alone.
 */
export class ArtifactsAuthScopeError extends ArtifactsError {}

/** The service asked us to back off (documented 2,000 req/10 s limits). */
export class ArtifactsRateLimitError extends ArtifactsError {}

/**
 * Fork-readiness polling (LIST status) exhausted its bounded retries without
 * observing `status: "ready"`. Carries the attempt count for evidence.
 */
export class ArtifactsForkNotReadyError extends ArtifactsError {
  readonly attempts: number;

  constructor(attempts: number, options: ArtifactsErrorOptions = {}) {
    super(`fork not ready after ${attempts} readiness poll(s) (list status never "ready")`, options);
    this.attempts = attempts;
  }
}

export interface RestErrorShape {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
}

export type GitHttpOperation = "push" | "fetch";

/**
 * Map a git smart-HTTP failure status to a typed error. Context: the real
 * service rejects a read-scope push with HTTP 400 (spike O27) — so for a
 * push, ANY 4xx maps to ArtifactsAuthScopeError; for fetch, 401/403 are
 * auth failures and 400 stays a generic ArtifactsError.
 */
export function classifyGitHttpError(status: number, operation: GitHttpOperation): ArtifactsError {
  if (status === 404) {
    return new ArtifactsNotFoundError(`git remote not found (HTTP 404)`, { status });
  }
  if (status === 429) {
    return new ArtifactsRateLimitError(`rate limited by Artifacts (HTTP 429)`, { status });
  }
  if (operation === "push" && status >= 400 && status < 500) {
    return new ArtifactsAuthScopeError(
      `push rejected with HTTP ${status} ` +
        `(read-scope pushes fail with HTTP 400 on the real service, not 401/403 — artifacts-spike O27)`,
      { status },
    );
  }
  if (status === 401 || status === 403) {
    return new ArtifactsAuthScopeError(`${operation} rejected with HTTP ${status} (bad or revoked token)`, { status });
  }
  return new ArtifactsError(`${operation} failed with HTTP ${status}`, { status });
}

/**
 * Map a REST envelope failure to a typed error (Cloudflare envelope:
 * `{success: false, errors: [{code, message}]}`). Recognized: 404 + 10200
 * → NotFound; 429 → RateLimit; 401/403 → AuthScope.
 */
export function mapRestError(status: number, body: unknown): ArtifactsError {
  const shape = (typeof body === "object" && body !== null ? body : {}) as RestErrorShape;
  const first = shape.errors?.[0];
  const serviceCode = typeof first?.code === "number" ? first.code : undefined;
  const message = first?.message ?? `Artifacts REST error (HTTP ${status})`;
  if (status === 404 || (serviceCode !== undefined && serviceCode === ARTIFACTS_ERROR_CODES.notFound)) {
    return new ArtifactsNotFoundError(`${message} (HTTP ${status}, code ${serviceCode ?? "n/a"})`, {
      status,
      serviceCode,
    });
  }
  if (status === 429) {
    return new ArtifactsRateLimitError(`${message} (HTTP 429)`, { status, serviceCode });
  }
  if (status === 401 || status === 403) {
    return new ArtifactsAuthScopeError(`${message} (HTTP ${status})`, { status, serviceCode });
  }
  return new ArtifactsError(`${message} (HTTP ${status}${serviceCode === undefined ? "" : `, code ${serviceCode}`})`, {
    status,
    serviceCode,
  });
}

/**
 * Best-effort normalization of an error THROWN BY THE BINDING. The real
 * binding's thrown shape is UNVERIFIED (no Worker deployed yet — spike
 * ASSUMED-D); we recognize the markers we can (`status`, `code`, `errors`
 * envelope fields, our own error classes) and pass anything else through
 * unchanged so no information is lost. This keeps the mapping in ONE place
 * for both the binding path (RealArtifacts) and the REST path (rest.ts).
 */
export function normalizeArtifactsError(err: unknown): unknown {
  if (err instanceof ArtifactsError) {
    return err;
  }
  if (typeof err !== "object" || err === null) {
    return err;
  }
  const candidate = err as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof candidate.status === "number" ? candidate.status : undefined;
  const serviceCode = typeof candidate.code === "number" ? candidate.code : undefined;
  if (status === undefined && serviceCode === undefined) {
    return err; // binding error shape UNVERIFIED — do not guess
  }
  return mapRestError(status ?? 0, {
    errors: [
      {
        code: serviceCode,
        message: typeof candidate.message === "string" ? candidate.message : undefined,
      },
    ],
  });
}
