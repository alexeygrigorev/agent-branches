/**
 * Boundary mappers between the REAL Cloudflare Artifacts shapes and the
 * provider-shape-free port types (src/types.ts). Evidence: artifacts-spike
 * (origin/proto/artifacts-spike @ c75faa1), sanitized transcript
 * appendix-transcript.md O13/O16/O17/O111.
 *
 * Finding B (CONFIRMED over REST): the commit shape is
 * `{hash, treeHash, message, author, committer, parents[], authoredAt,
 * committedAt}` with EPOCH-SECONDS instants — NOT the push-event shape
 * (`id`, ISO `timestamp`). The binding's generated type is still UNVERIFIED
 * (no `wrangler types` run against a live binding); until then the binding is
 * assumed to carry the same fields. NOTHING in the adapter may read `.id` or
 * `.timestamp` off a raw commit, and no ISO parse is attempted on the epoch
 * fields.
 */

import type { CommitMetadata, GitAuthor, RepoSummary } from "../types.js";

/** Raw commit as the real REST `log` route returns it (spike O13/O16). */
export interface RawCommit {
  hash: string;
  treeHash?: string;
  message: string;
  author?: GitAuthor;
  committer?: GitAuthor;
  parents: string[];
  /** Epoch SECONDS (e.g. 1791046799 → 2026-10-03T16:59:59.000Z). */
  authoredAt: number;
  /** Epoch SECONDS; the port timestamp is derived from this field. */
  committedAt: number;
}

/** Raw repo entry as LIST returns it (with status) / single GET (without). */
export interface RawRepo {
  id: string;
  name: string;
  description: string | null;
  default_branch: string;
  created_at?: string;
  updated_at?: string;
  /** ALWAYS null on the real service so far (spike finding 3) — never a signal. */
  last_push_at: string | null;
  source: string | null;
  read_only: boolean;
  remote: string;
  /** Present on LIST only (spike finding 2) — absent on single GET. */
  status?: string;
  /** Fork responses carry the copied object count (spike O9/O10). */
  objects?: number;
  /** create/fork responses embed a live initial token (spike O4/O9). */
  token?: string;
}

const PORT_REPO_STATUSES = ["ready", "importing", "forking"] as const;

export function isPortRepoStatus(value: string): value is (typeof PORT_REPO_STATUSES)[number] {
  return (PORT_REPO_STATUSES as readonly string[]).includes(value);
}

export function epochSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * The single REST/binding → port commit boundary (finding B). `id` comes
 * from `hash`; the port `timestamp` from epoch-seconds `committedAt`.
 * `treeHash` is real but has no port field — dropped deliberately.
 */
export function mapRawCommit(raw: RawCommit): CommitMetadata {
  if (typeof raw.hash !== "string" || raw.hash.length === 0) {
    throw new Error(`raw commit without hash (got ${JSON.stringify(raw)})`);
  }
  if (typeof raw.committedAt !== "number") {
    throw new Error(`raw commit ${raw.hash} without epoch-seconds committedAt (got ${JSON.stringify(raw.committedAt)})`);
  }
  return {
    id: raw.hash,
    message: raw.message,
    timestamp: epochSecondsToIso(raw.committedAt),
    parents: [...raw.parents],
    author: raw.author === undefined ? undefined : { ...raw.author },
    committer: raw.committer === undefined ? undefined : { ...raw.committer },
  };
}

/**
 * Raw repo → port summary. A missing `status` (single GET; or an unexpected
 * future value) maps to "importing" — the conservative NOT-ready state, so
 * readiness polling keeps waiting instead of proceeding on unknown data.
 */
export function mapRawRepoSummary(raw: Pick<RawRepo, "name" | "status">): RepoSummary {
  return {
    name: raw.name,
    status: raw.status !== undefined && isPortRepoStatus(raw.status) ? raw.status : "importing",
  };
}
