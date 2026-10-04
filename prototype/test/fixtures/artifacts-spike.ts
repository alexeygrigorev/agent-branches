/**
 * Fixtures built from the SANITIZED real-Artifacts transcript
 * (origin/proto/artifacts-spike @ c75faa1, artifacts-spike/appendix-transcript.md,
 * captured 2026-10-03 by zc-artifacts-1). These are the REAL response shapes
 * with every credential replaced by an obviously-fake opaque token in the
 * real `art_v2_x_<40hex>?expires=<unix>` format (the docs' `art_v1_` prefix
 * is wrong — spike finding 1). No secrets here; safe to commit.
 */

/** Spike O1: GET a missing namespace → 404, code 10200. */
export const SPIKE_NAMESPACE_NOT_FOUND = {
  result: null,
  success: false,
  errors: [
    {
      code: 10200,
      message: "Namespace not found",
      documentation_url: "https://developers.cloudflare.com/artifacts/api/errors#10200",
    },
  ],
  messages: [],
} as const;

/** Spike O2/O3: namespace create/get result. */
export const SPIKE_NAMESPACE = {
  namespace: "agent-branches-dev",
  jurisdiction: "unrestricted",
  repo_count: 0,
  created_at: "2026-10-03T16:57:42.016Z",
  updated_at: "2026-10-03T16:57:42.249Z",
} as const;

/** Opaque fake token in the REAL format (docs say art_v1_ — wrong). */
export const SPIKE_FAKE_REPO_TOKEN =
  "art_v2_x_f1e2d3c4b5a69f8e7d6c5b4a3928170665948372?expires=1791133107";

/** Spike O4: repo create result (token replaced with the fake above). */
export const SPIKE_REPO_CREATE = {
  id: "u7usp14xkllei2on",
  name: "demo-canonical",
  description: "agent-branches demo canonical base (spike)",
  default_branch: "main",
  remote: "https://<account_id>.artifacts.cloudflare.net/git/agent-branches-dev/demo-canonical.git",
  token: SPIKE_FAKE_REPO_TOKEN,
} as const;

/** Spike O5: token mint result (plaintext replaced; +1h ttl honored). */
export const SPIKE_TOKEN_MINT = {
  id: "e78473xkdxtgr1n9",
  plaintext: SPIKE_FAKE_REPO_TOKEN,
  scope: "write",
  expires_at: "2026-10-03T17:58:29.832Z",
} as const;

/** Spike O9: fork result — carries copied object count + a live write token. */
export const SPIKE_FORK = {
  id: "z23vslwndyq9lz2b",
  name: "demo-agent-1",
  description: "agent fork (spike)",
  default_branch: "main",
  remote: "https://<account_id>.artifacts.cloudflare.net/git/agent-branches-dev/demo-agent-1.git",
  token: SPIKE_FAKE_REPO_TOKEN,
  objects: 15,
} as const;

/**
 * Spike O13: real log entry — `hash` (not id), `treeHash`, epoch-SECONDS
 * `authoredAt`/`committedAt` (NOT ISO `timestamp`). b4346112… is the base
 * commit pushed to demo-canonical; 1791046799 → 2026-10-03T16:59:59.000Z.
 */
export const SPIKE_BASE_COMMIT = {
  hash: "b4346112b18a208d5f480e986b22c59d8339abb4",
  treeHash: "6adc109f3a08e4d1c4581259e70866603b2ea87e",
  message: "demo-target base state: shortlinks service (cloudflare-agent-git ff4decd, no .harness)",
  author: { name: "zc-artifacts-1", email: "zc-artifacts-1@aplexer.local" },
  committer: { name: "zc-artifacts-1", email: "zc-artifacts-1@aplexer.local" },
  parents: [] as string[],
  authoredAt: 1791046799,
  committedAt: 1791046799,
} as const;

/**
 * Spike O16: log after the 1-line push — c809475… with parent b4346112…;
 * 1791046878 → 2026-10-03T17:01:18.000Z.
 */
export const SPIKE_PUSHED_COMMIT = {
  hash: "c8094754895554f89cf816d55eee8207d14c9692",
  treeHash: "ba1ea03d9d1d9f9b1858292459ba1e42d59365c8",
  message: "spike: 1-line README change from demo-agent-1",
  author: { name: "Alexey Grigorev", email: "alexey.s.grigoriev@gmail.com" },
  committer: { name: "Alexey Grigorev", email: "alexey.s.grigoriev@gmail.com" },
  parents: ["b4346112b18a208d5f480e986b22c59d8339abb4"] as string[],
  authoredAt: 1791046878,
  committedAt: 1791046878,
} as const;

/**
 * Spike O111: single GET of a fork — note NO `status` field (finding 2) and
 * `last_push_at: null` right after a successful fork (finding 3).
 */
export const SPIKE_REPO_SINGLE_GET = {
  id: "z23vslwndyq9lz2b",
  name: "demo-agent-1",
  description: "agent fork (spike)",
  default_branch: "main",
  created_at: "2026-10-03T17:00:31.496Z",
  updated_at: "2026-10-03T17:00:33.963Z",
  last_push_at: null,
  source: "artifacts:agent-branches-dev/demo-canonical",
  read_only: false,
  remote: "https://<account_id>.artifacts.cloudflare.net/git/agent-branches-dev/demo-agent-1.git",
} as const;

/** Spike O17: repo LIST — the only surface carrying `status` (finding 2). */
export const SPIKE_REPOS_LIST = [
  {
    id: "z23vslwndyq9lz2b",
    name: "demo-agent-1",
    description: "agent fork (spike)",
    default_branch: "main",
    created_at: "2026-10-03T17:00:31.496Z",
    updated_at: "2026-10-03T17:00:33.963Z",
    last_push_at: null,
    source: "artifacts:agent-branches-dev/demo-canonical",
    read_only: false,
    remote: "https://<account_id>.artifacts.cloudflare.net/git/agent-branches-dev/demo-agent-1.git",
    status: "ready",
  },
  {
    id: "nzhkzbxleu7eyjds",
    name: "demo-agent-2",
    description: "agent fork (spike)",
    default_branch: "main",
    created_at: "2026-10-03T17:00:35.968Z",
    updated_at: "2026-10-03T17:00:37.971Z",
    last_push_at: null,
    source: "artifacts:agent-branches-dev/demo-canonical",
    read_only: false,
    remote: "https://<account_id>.artifacts.cloudflare.net/git/agent-branches-dev/demo-agent-2.git",
    status: "ready",
  },
  {
    id: "u7usp14xkllei2on",
    name: "demo-canonical",
    description: "agent-branches demo canonical base (spike)",
    default_branch: "main",
    created_at: "2026-10-03T16:58:27.113Z",
    updated_at: "2026-10-03T16:58:28.193Z",
    last_push_at: null,
    source: null,
    read_only: false,
    remote: "https://<account_id>.artifacts.cloudflare.net/git/agent-branches-dev/demo-canonical.git",
    status: "ready",
  },
] as const;
