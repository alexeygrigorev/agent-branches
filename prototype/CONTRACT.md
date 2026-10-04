# Agent Branches prototype — HTTP + integration contract

version: 0.1.4
(Pin this version when building against it: L2 review UI, L3 radar runner,
L4/L5 demo lanes. Any breaking change bumps the version.)

Changes since 0.1.3 (facade extraction, 2026-10-03 — DOCS ONLY):

**No wire change of any kind.** Every route, status code, body shape and
auth rule is byte-identical to 0.1.2/0.1.3; the existing suites (88 workerd
tests + 16 sidecar tests) pass unchanged. What changed is the INTERNAL
STRUCTURE, so future provider swaps stop being rewrites:

1. **Ports.** `src/ports/` now defines the provider-neutral interfaces:
   `GitHost` (the former `ArtifactsPort`, renamed, alias kept),
   `CoordinationStore` (transactional get/put, linearizable), `PushEvents`
   (one normalized `PushEvent` from any notification source), `Clock` /
   `IdGenerator`. Details: ARCHITECTURE.md.
2. **Core.** `src/core/` holds ALL coordination logic (`CoordinatorCore`),
   the pure auth decisions, and THE one route implementation
   (`handleRoute`) over a neutral HttpRequest/HttpResponse. No
   `cloudflare:*`, no env, no Request/Response — enforced by
   `test/node/architecture.test.ts` and a workerd-free tsc build.
3. **Adapters.** Cloudflare (`src/cloudflare/`: Coordinator DO, DO storage
   store, Artifacts binding GitHost, event-subscription PushEvents,
   Request/Response mapping) and local (`src/local/`: memory/file store,
   git-sidecar GitHost, post-receive webhook PushEvents, and a ZERO-DEPENDENCY
   `node:http` runtime entry serving the same routes from the same core).
4. **New test lane.** `npm run test:node` — 27 plain-`node --test` tests
   (no workerd) covering the core rules, wire parity of every route over
   the neutral router, a real node:http round trip, and the architecture
   gate. `test:all` runs all three suites.
5. **Boundary fix found by the new suite.** `status()` and the push result
   no longer hand out the LIVE heads object (both HTTP wires always
   serialized it, so nothing observable changed — direct core consumers
   could have aliased internal state).

Version 0.1.3 was the real-Artifacts spike fold-in (below); it is retained
as the last wire-affecting revision.

Changes since 0.1.2 (real-Artifacts spike fold-in, 2026-10-03):

The adapter now matches the REAL Cloudflare Artifacts service as measured by
the artifacts-spike (origin/proto/artifacts-spike @ c75faa1: RESULTS.md,
appendix-transcript.md, PLAN-L1-REAL.md). No HTTP route of this Worker
changed; the ArtifactsPort real-mode semantics and the docs table did.

1. **COMMIT FIELDS ARE REAL-SHAPED (finding B, CONFIRMED over REST).** The
   real service's `log`/commit shape is `{hash, treeHash, message, author,
   committer, parents[], authoredAt, committedAt}` with **epoch-SECONDS**
   instants — not `id` + ISO `timestamp`. `RealArtifacts` exposes the raw
   shape at the capability seam (`src/artifacts/real.ts`) and maps to the
   port's `CommitMetadata` (`id` from `hash`, `timestamp` from epoch
   `committedAt`) at exactly one boundary (`src/artifacts/map.ts`). The
   push-event envelope (`id` + ISO `timestamp`, ASSUMED-E still UNVERIFIED
   end-to-end) is normalized at the same boundary.
2. **TOKENS ARE OPAQUE (finding 1, CONFIRMED).** The real service issues
   `art_v2_x_<40hex>?expires=<unix>`, NOT the documented `art_v1_…`. No
   adapter code validates, normalizes or trims a token string; the
   `?expires=` suffix convention and ttl honoring (3600→+1h, 600→+10min)
   are confirmed. Fork/create responses embed a live ~24h write token —
   store deliberately or revoke (validated DELETE), never log it.
3. **FORK READINESS VIA LIST (findings 2+F, CONFIRMED).** Forks are
   default-branch ONLY (no fork-at-commit; head == source default-branch
   head). `RealArtifacts.fork` now polls the LIST response's `status`
   field — the only surface that has one (single GET omits it; a missing
   status maps to the conservative NOT-ready state) — with bounded retries
   (`RealArtifactsOptions.readiness`, default 20×500 ms) and throws
   `ArtifactsForkNotReadyError` on exhaustion. `last_push_at` stays `null`
   forever (finding 3) and is never consulted.
4. **TYPED ERRORS (findings 4/5, CONFIRMED).** `src/artifacts/errors.ts`:
   namespace/repo not found = HTTP 404 + Cloudflare code **10200** →
   `ArtifactsNotFoundError`; a read-scope push is rejected with **HTTP 400**
   (NOT 401/403, ~52 ms, nothing written) → `ArtifactsAuthScopeError` via
   `classifyGitHttpError`; 429 → `ArtifactsRateLimitError`. The same
   mapping serves the binding path (best-effort: the binding's thrown shape
   is UNVERIFIED, unrecognized errors pass through untouched) and the REST
   path (exact envelope parsing).
5. **REST SEAM FOR BOOTSTRAP (finding 6, CONFIRMED).** Wrangler 4.147.0 has
   `artifacts namespaces|repos list/get` but NO namespace-create and NO
   fork subcommand: from scripts those go through REST
   (`src/artifacts/rest.ts`, thin client, fetch injectable, Bearer header
   only — tokens never in URLs). Inside the Worker the binding covers the
   same operations (PLAN-L1-REAL §1 decision: do not port the whole port to
   REST).

Real-mode CONFIRMED vs ASSUMED (evidence: artifacts-spike @ c75faa1):

| Concern | Status | Evidence |
| --- | --- | --- |
| Commit fields `hash`/`treeHash` + epoch `authoredAt`/`committedAt` (REST) | **CONFIRMED** | O13/O16 |
| Binding-side commit type shape | **UNVERIFIED** — assumed to match REST; close with `npx wrangler types` after adding the binding | — |
| Tokens `art_v2_x_…?expires=…`, opaque; ttl honored; scope in mint+list | **CONFIRMED** | O5/O22/O26; finding 1 |
| Fork: default-branch only, `objects` copied, token+remote returned | **CONFIRMED** | O9/O10/O13; F |
| `status` only on repo LIST; missing → treat as NOT ready | **CONFIRMED** | O17 vs O11/O12 |
| `last_push_at` always `null` | **CONFIRMED** | O17/O21 after pushes |
| Read-scope push → HTTP 400, fast, nothing written | **CONFIRMED** | O27 |
| Not-found = 404 + code 10200 | **CONFIRMED** | O1 |
| No refs enumeration; head via `log({limit:1})`; refs via git only | **CONFIRMED** (ASSUMED-A) | O13/O16/O18/O19 |
| No merge APIs (Worker never merges) | **CONFIRMED** (ASSUMED-A family) | full REST page review |
| Binding visible in the DO (`env.ARTIFACTS`) | **UNVERIFIED** (D) — needs binding config + a Worker run | — |
| Event subscriptions (`cf.artifacts.repo.pushed` delivery) | **UNVERIFIED** (E) — envelope implemented, subscription creation + delivery guarantees untested | — |
| Namespace/repo create + fork from CLI | REST-only (no wrangler subcommand) | finding 6 |
| Control-plane rate 2,000 req/10 s | documented; untested at scale | docs |

Changes since 0.1.1 (codex C-1350 + C-1357, 2026-10-03):

1. **CANONICAL v0.1 CHECKS WIRE** — `POST /checks` accepts the typed shape
   the L3 runner emits (`radar/engine.py export_l1_payload`,
   origin/proto/l3-radar). The payload MUST declare its wire via
   `contract` (breaking): `"0.1"` for the canonical typed shape, `"0.0"`
   for the legacy string adapter; anything else — including a missing
   `contract` field — is **400**. Exact canonical request:

   ```json
   {
     "contract": "0.1",
     "vector": { "<agentId>": "<40-hex sha>" },
     "policy": { "merge": "git-merge-tree",
                 "tests": { "command": ["pytest", "-q"] | "pytest -q" | null,
                            "budget_s": 15.0 } },
     "coverage": { "pairs_checked": 3, "tests_collected": 12 },
     "results": [
       { "pair": ["agent-a", "agent-b"],          // both known agents
         "heads": { "agent-a": "<sha>", "agent-b": "<sha>" },  // required,
            // every pair agent, values must match the submitted vector
            // (checked AFTER the stale gate, so stale stays 409)
         "status": "conflict" | "clean" | "unknown",
         "kind": "textual" | "test" | null,
         "evidence": { "summary": "human-readable one-liner",  // required;
                       // falls back through details/error/reason exactly
                       // like the L3 exporter
                       "files": ["path"],
                       "test_output_tail": "…",
                       "tests_collected": 4,    // per-pair combined coverage
                       "…": "further diagnostics preserved verbatim" } }
     ]
   }
   ```

   The legacy **contract "0.0"** adapter accepts the pre-0.1 shape verbatim
   (string `policy`, string[] `coverage`, per-result string `evidence`,
   free-form `kind`); it exists so 0.1.0/0.1.1 callers keep working and MUST
   be declared. Errors name the offending field (400).

2. **PAIR VIEWS ALIGN TO THE WIRE** (GET /status `pairs[]` and the
   `POST /checks` response `pairs[]`; breaking for positional readers):
   - `heads` is keyed by **agentId** (`{ "agent-a": "<sha>" }`), no longer
     positional `{a, b}` — this is what the L4 UI's clean gate matches
     (prototype/ui/pair-status.js).
   - `coverage` is the **per-pair** coverage `{ "tests_collected": N }` from
     that pair's own combined test run (0.1 `evidence.tests_collected`;
     the runner's top-level `coverage` counts are recorded on
     `lastRunnerReport`, not per pair). Present only while the check is
     fresh; the L4 UI shows Clean only with clean status + current heads +
     `tests_collected > 0`.
   - `evidence` is the string evidence (0.0) or the verbatim typed evidence
     object (0.1). Warnings/radarLog keep human-readable summary strings.
   - `lastRunnerReport.policy`/`.coverage` are recorded verbatim (string for
     0.0, policy/counts objects for 0.1).

3. **SILENT-CALLBACK GUARD** (codex C-1357): a git push whose post-receive
   callback to `POST /events/push` fails auth/delivery must NOT become a
   silent "no warnings". The sidecar retries the delivery **3 times**
   (50/100/200 ms backoff), then records the push in a durable
   `notify-state.json` ledger, exposed at `GET /api/notify-state`. The
   Worker pulls it for `GET /status`:
   - top-level `unprocessedPushes: [{repo, ref, sha, before, attempts,
     firstAt, lastAt, lastError, agentId|null}]`;
   - any pair involving an agent whose fork has an unprocessed record shows
     `status: "not_checked"` with `unprocessedReason` and `stale: true` —
     its true head is unknown, so a previously stored clean/conflict NEVER
     presents as current until a later successful delivery supersedes the
     record (same repo+ref) or the ledger is cleared.
   `POST`/`DELETE /api/notify-state` are bearer-gated dev/test helpers.
   An unconfigured `SIDECAR_NOTIFY_URL` remains the documented local
   no-worker mode and is NOT recorded as unprocessed. Port surface: the new
   optional `ArtifactsPort.unprocessedPushes()` is local-mode only
   (docs-notes ASSUMED-G: a real deployment learns delivery state from its
   Artifacts event subscription).

Changes since 0.1 (muse-r46 cross-family review, 2026-10-03):

1. **AUTH — all mutating routes now require a bearer token** (breaking).
   `/events/push`, `/events/artifacts`, `/tasks/:id/tests` and
   `/warnings/:id/ack` accept ADMIN_TOKEN, the relevant agent's per-task
   token (the write token minted at `POST /tasks`, verified by SHA-256
   digest in the DO) or — for the two `/events/*` webhooks only — the
   sidecar shared bearer (`LOCAL_ARTIFACTS_TOKEN`). Cross-agent writes are
   rejected with **403** (agent A's token cannot post tests/acks/pushes for
   agent B). Read routes (`GET /status`, `GET /tasks/:id`) stay open.
   **This includes the sidecar's post-receive callback**: the hook's
   delivery to `POST /events/push` carries the shared bearer and is
   token-gated like any other push report — an unauthorized/failed callback
   is a LOST push, not a quiet success (see change 3 above and the sidecar
   guard). `POST /checks` keeps its dedicated `RUNNER_TOKEN` gate. Tokens
   are secrets: per-agent workspaces keep them in a 0600 git-ignored file
   or env, never in argv, URLs/query strings, logs or published evidence.
2. **D1 — pair order is canonical.** A conflict submitted as `[a,b]` and
   then `[b,a]` at unchanged heads maps to ONE pairChecks record and at
   most ONE active warning; stored `pair`/`headsAtIssue`/check vectors are
   always sorted by agent id.
3. **D2 — push dedup memory is bounded** (16 latest pushes per agent,
   ring; older redeliveries are treated as new pushes and re-verified).
4. **D3 — real-mode `POST /tasks` works.** The documented binding cannot
   fork at a commit (docs-notes ASSUMED-F): real mode forks the default
   branch and records the fork's head at creation as `base_sha` (an
   explicit `base_sha` equal to the canonical tip is honored exactly).
   Local mode is unchanged.
5. **READ AUTH — `GET /status` and `GET /tasks/:id` require a bearer
   token** (codex C1462 Task 1, breaking; supersedes "read routes stay
   open" above). `GET /status` accepts ADMIN_TOKEN, RUNNER_TOKEN (the
   runner fetches the heads vector before `POST /checks`) or any valid
   per-task agent token. `GET /tasks/:id` is owner-or-admin: a valid token
   for a DIFFERENT agent is **403**. The token expiry (denied AT the expiry
   instant) and revocation gates apply to reads exactly as to writes; the
   sidecar webhook bearer is ingest-only and is NOT a read credential.
   Anything else — missing, malformed, unknown, expired or revoked
   credentials — is **401** with
   `{ "error": "unauthorized", "message": "Missing or invalid bearer token" }`.
   Auth resolves before task existence, so anonymous callers cannot probe
   task ids.

## Deployment boundary (codex C-1309)

The Worker and its Coordinator Durable Object **never run git and never run
tests**. They only coordinate state:

- **Local mode**: all repos are REAL bare git repos on disk, served by the
  Node sidecar (`prototype/local-artifacts/`). The Worker calls the sidecar
  over `fetch` (`LOCAL_ARTIFACTS_URL`). Agents use ordinary
  `git clone` / `git push` against the sidecar's smart-HTTP endpoints with
  per-repo tokens. The sidecar's post-receive hook notifies the Worker.
- **Real mode** (once a Cloudflare account exists): the same port is
  implemented over the documented Cloudflare Artifacts binding.
- The radar (trial merges / tests) runs in a **separate trusted local runner
  process** (L3), which submits results via `POST /checks`.

Sidecar (local mode, Node built-ins + system git only, binds 127.0.0.1):

```
npm run sidecar          # env: SIDECAR_ROOT, SIDECAR_HOST, SIDECAR_PORT,
                         #      SIDECAR_TOKEN (shared bearer for /api/*),
                         #      SIDECAR_NOTIFY_URL (default none)
```

Worker env (`.dev.vars` for wrangler dev, miniflare bindings in tests):

| Variable | Used by | Meaning |
| --- | --- | --- |
| `ADMIN_TOKEN` | POST /setup, POST /tasks, (all authenticated routes, reads included) | admin bearer; unset => 503 fail closed |
| `RUNNER_TOKEN` | POST /checks, GET /status | trusted radar runner bearer |
| `LOCAL_ARTIFACTS_URL` | Coordinator | sidecar base URL (local mode) |
| `LOCAL_ARTIFACTS_TOKEN` | Coordinator + `/events/*` auth | sidecar shared bearer; also accepted by the two webhook routes (`/events/push`, `/events/artifacts`); must equal the sidecar's `SIDECAR_TOKEN` |
| `ARTIFACTS` | Coordinator | real Cloudflare Artifacts binding (real mode) |
| `RADAR_IMPL` | Coordinator | `stub` (default) or `silent` |

Agent per-task tokens (write tokens returned by `POST /tasks`) authenticate
their agent on `/events/push`, `/tasks/:id/tests`, `/warnings/:id/ack`,
`GET /status` (any valid agent token) and `GET /tasks/:id` (owner only);
the DO stores only a SHA-256 digest. Tokens are never logged or echoed in
error bodies. `wrangler dev` binds localhost only; deploying publicly
requires an auth review first — checklist: token rotation, TLS, a DEDICATED
rotated secret for the Artifacts event subscription on `/events/artifacts`
(today the sidecar shared bearer stands in), and re-reviewing the
`LOCAL_ARTIFACTS_TOKEN`-on-`/events/*` equivalence.

## Routes

All bodies are JSON. Errors: `{ "error": string }` (+ extra fields where
noted). Statuses: 400 bad input, 401 bad/missing bearer, 403 valid token
but wrong agent (cross-agent write, or foreign task read), 404 unknown
task/warning, 409 stale vector, 503 auth secret unconfigured.

### POST /setup — admin

Creates the canonical repo (one per Coordinator). Idempotent once created.

```json
// response 201
{ "canonical": { "name": "agent-branches-canonical-<8hex>", "remote": "http://127.0.0.1:8790/git/agent-branches-canonical-<8hex>.git" },
  "created": true, "seedCommit": "<40-hex>" }
```

### POST /tasks — admin (codex C-1306)

```json
// request
{ "agent": "claude",          // required-ish; slugified into agentId-<seq>
  "intent": "fix login loop", // optional free text, shown on the review screen
  "base_sha": "<40-hex>",     // optional canonical commit to fork from
  "ttlSeconds": 3600 }        // optional fork token TTL
// response 201
{ "taskId": "task-0007",
  "agentId": "claude-0007",
  "fork": { "name": "agent-branches-canonical-<8hex>-claude-0007",
            "remote": "http://127.0.0.1:8790/git/<fork>.git" },
  "ref": "refs/heads/main",
  "base_sha": "<40-hex canonical commit the fork started from>",
  "intent": "fix login loop" | null,
  "token": { "scope": "write", "expiresAt": "ISO", "plaintext": "art_v1_<40hex>?expires=<unix>" },
  "head": "<40-hex fork head == base_sha at creation>" }
```

`base_sha` defaults to the canonical head; an explicit base must exist in
the canonical first-parent history (400 otherwise). In local mode the fork
starts exactly at `base_sha`. In real mode the binding can only fork the
default branch (docs-notes ASSUMED-F, muse-r46 D3): an explicit `base_sha`
that equals the canonical tip is honored exactly; an older one records the
fork's head at creation as `base_sha` instead. Agents then `git push`
to `fork.remote` with `git -c http.extraHeader="Authorization: Bearer
$plaintext"`; the sidecar hook reports the push automatically. The same
`token.plaintext` is the agent's credential on `/events/push`,
`/tasks/:id/tests` and `/warnings/:id/ack` (CONTRACT 0.1.1); the DO keeps
only its SHA-256 digest.

### POST /events/push — agent's task token | ADMIN_TOKEN | sidecar bearer

```json
// request: agent or fork identifies the pusher
{ "agent": "claude-0007", "sha": "<40-hex>" }
// or (sidecar post-receive webhook shape)
{ "fork": "<forkName>", "ref": "refs/heads/main", "sha": "<40-hex>", "before": "<40-hex>" }
// response 200
{ "accepted": true, "deduped": false, "agent": "claude-0007",
  "heads": { "claude-0007": "<sha>", ... },
  "invalidatedWarnings": ["warn-3"],   // warnings involving this agent
  "newWarnings": [],                   // only ever conflict-driven (see radar)
  "radarChecks": 3 }                   // pairs recorded as not_checked
```

Head advances are privileged (muse-r46 AUTH): the pushing agent's own
per-task token, ADMIN_TOKEN, or — for the `{fork,...}` webhook shape — the
sidecar shared bearer. A valid token for a DIFFERENT agent is 403.
`sha` must be a real commit in the agent's fork (400 otherwise). Repeated
(agent, sha) pushes are deduped (`"deduped": true`); dedup memory is
bounded to the latest 16 pushes per agent (muse-r46 D2).

### POST /events/artifacts — sidecar bearer | ADMIN_TOKEN (webhook ingest)

Accepts the documented `cf.artifacts.repo.pushed` envelope (see
docs-notes.md source 3); resolves the fork to an agent and behaves like
/events/push. Unknown forks => 202 `{accepted:false}`. Authenticated with
the shared subscription bearer (the sidecar's `SIDECAR_TOKEN` == the
Worker's `LOCAL_ARTIFACTS_TOKEN` in local mode; a real deployment must
configure a dedicated secret — pre-deploy checklist).

### POST /checks — RUNNER_TOKEN (trusted radar runner, L3)

The payload MUST declare its wire: `contract: "0.1"` (canonical typed
shape, L3 `export_l1_payload`) or `contract: "0.0"` (legacy adapter,
pre-0.1 string shape). Missing/unknown contract => 400. See the 0.1.2
change list above for the exact canonical request shape.

```json
// request (0.1 excerpt — vector/policy/coverage/results as documented above)
// request (0.0 legacy adapter — the pre-0.1 shape, verbatim)
{ "contract": "0.0",
  "vector": { "claude-0007": "<sha>", "codex-0008": "<sha>", ... },
  "policy": "merge-tree-v1",
  "coverage": ["claude-0007|codex-0008"],
  "results": [
    { "pair": ["claude-0007", "codex-0008"],
      "status": "conflict",                        // conflict|clean|unknown
      "kind": "merge-conflict",                    // free-form classifier
      "evidence": "git merge-tree exit 1" } ] }
// response 200
{ "stale": false, "accepted": 2, "currentHeads": { ... },
  "pairs": [ /* PairStatusView[] as in /status */ ],
  "createdWarnings": [ /* WarningRecord[] */ ],
  "runnerReport": { "policy": <verbatim>, "coverage": <verbatim>, "accepted": 2, "at": "ISO", "vector": { ... } } }
// response 409 (vector != current head vector — refetch /status and retry)
{ "error": "stale vector: heads have moved since the runner fetched them; re-fetch /status and retry",
  "currentHeads": { ... } }
```

### GET /status — bearer required (admin, runner or valid agent token)

```json
{ "canonical": { "name": "...", "remote": "..." },
  "agents": [ { "agentId": "claude-0007", "taskId": "task-0007", "forkName": "...",
                "forkRemote": "...", "ref": "refs/heads/main", "head": "<sha>|null",
                "pushes": 3, "createdAt": "ISO", "lastPushAt": "ISO|null" } ],
  "heads": { "claude-0007": "<sha>" },
  "pairs": [ { "pair": ["a","b"],
               "heads": { "a": "<sha>", "b": "<sha>" },  // KEYED BY agentId (0.1.2)
               "status": "conflict|clean|unknown|not_checked",
               "kind": "textual"?, "evidence": <string|typed object>?,
               "coverage": { "tests_collected": 5 }?,    // per-pair, fresh only (0.1.2)
               "checkedAt": "ISO|null",       // last check time, even if stale
               "stale": false,                // stored check exists but heads moved
               "unprocessedReason": "..."?,   // 0.1.2: a member's push was lost
               "activeWarningIds": ["warn-3"] } ],
  "warnings": [ /* WarningRecord, newest first, capped 20 */ ],
  "radarLog": [ { "at": "ISO", "pair": ["a","b"], "heads": {...}, "status": "not_checked" } ],
  "lastRunnerReport": { ... } | null,
  "unprocessedPushes": [ { "repo": "<fork>", "ref": "refs/heads/main", "sha": "<40-hex>",
                           "before": "<40-hex>|null", "attempts": 3, "firstAt": "ISO",
                           "lastAt": "ISO", "lastError": "worker responded 401",
                           "agentId": "claude-0007" } ] }
```

`not_checked` (never checked at these heads — includes stale) is always
visibly distinct from `clean`. While an agent has an unprocessed push
(codex C-1357), every pair containing it is forced to `not_checked` with
`unprocessedReason` set and `stale: true`: the agent's true head is
unknown, so a stored clean never presents as current.

### GET /tasks/:id — bearer required (owning agent or admin)

```json
{ "taskId": "task-0007", "agentId": "claude-0007",
  "forkName": "...", "forkRemote": "...", "ref": "refs/heads/main",
  "createdAt": "ISO",
  "base_sha": "<40-hex>", "intent": "fix login loop" | null,
  "head": "<current sha>|null", "pushes": 3,
  "agent": { /* AgentRecord */ } | null,
  "warnings": [ { "id": "warn-3", "pair": ["a","b"],
                  "headsAtIssue": { "a": "<sha>", "b": "<sha>" },
                  "reason": "merge-conflict", "kind": "merge-conflict"?,
                  "evidence": "..."?, "status": "active"|"invalidated",
                  "createdAt": "ISO", "invalidatedAt": "ISO|null",
                  "resolvedBy": "clean check (policy)"?,
                  "acks": [ { "agent": "claude-0007", "head": "<sha at ack>",
                              "note": "rebase in progress"?, "at": "ISO" } ] } ],
  "testProvenance": { "command": "npm test", "exit": 0,
                      "head_sha": "<40-hex>", "at": "ISO" } | null }
```

### POST /tasks/:id/tests — the task's agent token | ADMIN_TOKEN

```json
{ "command": "npm test", "exit": 0, "head_sha": "<40-hex in the fork>" }
// 201 { "testProvenance": { "command": "npm test", "exit": 0, "head_sha": "...", "at": "ISO" } }
```

`head_sha` must exist in the fork (400 otherwise). Last post wins.
Evidence gate (muse-r46 AUTH §a.2): another agent's valid token is 403 —
unauthenticated test-provenance forgery is rejected.

### POST /warnings/:id/ack — the acking agent's token | ADMIN_TOKEN (attestational)

```json
{ "agent": "claude-0007", "note": "rebase in progress" }
// 200 { "warning": { /* WarningRecord with acks */ } }
```

Records which agent acknowledged which warning at which head (404 unknown
warning, 400 unknown agent). muse-r46 AUTH: the credential must belong to
`body.agent` — agent A cannot ack as agent B (403); the sidecar bearer is
NOT accepted on this attestational route.

## Radar hook contract (src/radar.ts)

```ts
type RadarStatus = "conflict" | "clean" | "unknown" | "not_checked";
interface RadarPairResult {
  pair: [string, string];
  heads: { a: string; b: string };
  status: RadarStatus;   // see semantics below
  kind?: string;         // conflict classifier, e.g. "merge-conflict"
  evidence?: string;     // how it was determined
}
interface Radar {
  onPush(change: HeadChange, heads: HeadVector, siblings: string[]): RadarPairResult[];
}
```

Semantics (codex C-1305 #1):

- **conflict** — checked at exactly these heads, real conflict found. The
  ONLY status that creates a warning.
- **clean** — checked at exactly these heads, no conflict. A clean result
  at the same heads auto-resolves that pair's active warning.
- **unknown** — checked but inconclusive. Recorded distinctly; never a
  warning, never clean.
- **not_checked** — no check covers the current heads. This is what the
  in-Worker `StubRadar` always reports (differing heads alone are NEVER an
  active warning) and what a pair reverts to after either head advances
  (`stale: true` flags the outdated stored check).
- Pushing invalidates active warnings whose pair includes the pushing
  agent; only a fresh runner `conflict` at the new heads opens a new one.

## ArtifactsPort (src/types.ts) — documented vs REALITY (spike c75faa1)

| Port method | Real mode (binding) | Status |
| --- | --- | --- |
| `createRepo` | `create(name, opts)` | documented |
| `fork(source, target, opts)` | `repo.fork(name, opts)` + LIST-status readiness poll | documented; fork is default-branch ONLY (F CONFIRMED) — `opts.baseSha` is stripped and the **realized** base (fork head after ready) is reported (muse-r46 D3); readiness via LIST only (finding 2), bounded, `ArtifactsForkNotReadyError` on exhaustion |
| `mintToken` | `repo.createToken(scope, ttl)` | documented; scope CONFIRMED (C); token OPAQUE `art_v2_x_…` (finding 1) |
| `log` | `repo.log(opts)` → raw `{hash,…,epoch}` mapped to `CommitMetadata` | documented; REAL field names CONFIRMED over REST (B, O13/O16); binding-side type UNVERIFIED |
| `headCommit` | `repo.log({ref, limit:1})` | derived from a documented op; no ref enumeration exists (A CONFIRMED) |
| `hasCommit` | `repo.readCommit(sha)` | documented |
| `listRepos` / `deleteRepo` | `list` / `delete` | documented; `status` on LIST only (finding 2), missing → NOT ready |
| `unprocessedPushes?` | `[]` (real delivery state lives in the event subscription, E UNVERIFIED) | C-1357, local-mode only |

Bootstrap-side REST operations (no wrangler subcommand exists for these —
finding 6): namespace create/get/ensure, repo create/get/list/delete, fork,
token mint/list/revoke, log — `src/artifacts/rest.ts`, sharing the error
mapping (`src/artifacts/errors.ts`) and mappers (`src/artifacts/map.ts`).
The Worker never needs the REST client; scripts (bootstrap) never need the
binding.

No merge or ref-enumeration APIs exist on the port (codex C-1309 #8): the
Worker cannot and does not perform trial merges. Full spike evidence:
`artifacts-spike/RESULTS.md` on origin/proto/artifacts-spike (@ c75faa1);
local doc notes: `docs-notes.md`.

## Sidecar API (local mode, 127.0.0.1)

Admin JSON API (bearer `SIDECAR_TOKEN` when configured):
`GET /api/health`, `POST /api/repos {name, defaultBranch?}`,
`GET /api/repos`, `POST /api/repos/:name/fork {target, baseSha?}`,
`POST /api/repos/:name/tokens {scope, ttlSeconds?}`,
`GET /api/repos/:name/head?ref=`, `GET /api/repos/:name/log?ref&limit&offset`,
`GET /api/repos/:name/hascommit?sha=`, `POST /api/repos/:name/commits
{message, ref?}` (test/dev helper), `DELETE /api/repos/:name`,
`GET /api/notify-state` (C-1357 callback-loss ledger),
`POST /api/notify-state {repo, ref, sha, ...}` (test/dev inject helper),
`DELETE /api/notify-state` (test/dev clear helper).

Git smart HTTP (per-repo token auth; `read` scope cannot push):
`GET /git/:name.git/info/refs?service=...`,
`POST /git/:name.git/git-upload-pack`,
`POST /git/:name.git/git-receive-pack`.

Push webhook: post-receive -> sidecar `/hooks/push` -> forwarded to
`SIDECAR_NOTIFY_URL` (point it at the Worker's `/events/push`) as
`{fork, ref, sha, before}`.
