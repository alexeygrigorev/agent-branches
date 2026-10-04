# Agent Branches — L1 scaffold prototype

Shared base for the "Agent Branches" competition entry: several coding agents
change code concurrently; each agent works in its own fork of a canonical
repo; a Durable Object coordinator tracks per-agent WIP heads and surfaces
radar conflict warnings fed by a trusted local runner.

**The Worker/DO never runs git and never runs tests** (codex C-1309
deployment boundary). In local mode the repos are REAL bare git
repositories on disk, served by a small Node sidecar; agents clone/push
with ordinary git; the radar runs in a separate trusted runner process (L3)
and submits results over an authenticated, vector-gated route.

Exact routes, request/response shapes, the radar hook contract, auth and
the sidecar API are specified in **[CONTRACT.md](CONTRACT.md) (version
0.1.3)** — L2/L3/L4 build against that file, not against this README.

## Run

```bash
cd prototype
npm install          # ~325 MiB node_modules, single workerd stack
npm run typecheck    # tsc --noEmit
npm test             # worker tests inside workerd, against a real-git sidecar
npm run test:sidecar # sidecar tests with a real git client (clone/push/webhook)
npm run test:node    # core + router + local adapters under plain node --test (NO workerd)
npm run test:all     # typecheck + all three suites

# local dev: sidecar + worker (two terminals)
npm run sidecar                    # binds 127.0.0.1:8790 (env-overridable)
cp .dev.vars.example .dev.vars     # set ADMIN_TOKEN, RUNNER_TOKEN, ...
npx wrangler dev --local

# OR: same routes from the SAME core on plain node:http (no Cloudflare):
npm run sidecar
LOCAL_ARTIFACTS_URL=http://127.0.0.1:8790 \
ADMIN_TOKEN=... RUNNER_TOKEN=... LOCAL_ARTIFACTS_TOKEN=... \
PORT=8787 node .build/node/src/local/main.js   # after npm run build:node
```

Then, against http://localhost:8787 (see CONTRACT.md for full shapes):

```bash
# canonical repo is also auto-created on first POST /tasks
curl -s -X POST localhost:8787/setup -H 'authorization: Bearer $ADMIN_TOKEN'

# one task = one agent fork (a real bare repo on the sidecar)
curl -s -X POST localhost:8787/tasks -H 'authorization: Bearer $ADMIN_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"agent":"claude","intent":"fix login loop"}'
# => { taskId, agentId, fork:{name,remote}, base_sha, intent, token, head }

# the agent pushes with ordinary git; the sidecar hook reports it:
git -c http.extraHeader="Authorization: Bearer $TOKEN" push <remote> main
# (equivalent manual report — the agent authenticates with its task token:)
curl -s -X POST localhost:8787/events/push -H 'content-type: application/json' \
  -H 'authorization: Bearer $TOKEN' \
  -d '{"agent":"claude-0001","sha":"<40-hex>"}'

# trusted radar runner (L3) submits conflict/clean/unknown results:
curl -s -X POST localhost:8787/checks -H 'authorization: Bearer $RUNNER_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"vector":{...},"policy":"merge-tree-v1","results":[{"pair":[...],"status":"conflict"}]}'

curl -s localhost:8787/status       # per-pair conflict|clean|unknown|not_checked
curl -s localhost:8787/tasks/task-0001   # base_sha, intent, head, warnings+acks, tests
```

## Auth

ALL mutating routes are authenticated (muse-r46 review, CONTRACT 0.1.1):

- `POST /setup` and `POST /tasks` (including the fork write-token minted
  there) require `Authorization: Bearer $ADMIN_TOKEN`.
- `POST /checks` (trusted radar runner results) requires
  `Authorization: Bearer $RUNNER_TOKEN`.
- `POST /events/push`, `/events/artifacts`, `/tasks/:id/tests` and
  `/warnings/:id/ack` accept `ADMIN_TOKEN`, the relevant agent's per-task
  token (the write token from `POST /tasks`; the DO stores only its
  SHA-256 digest), or — webhooks only — the sidecar shared bearer
  (`LOCAL_ARTIFACTS_TOKEN`). A valid token for a DIFFERENT agent is
  rejected with `403` (no cross-agent writes: an agent cannot post test
  provenance or acks for another agent).
- Missing or wrong token → `401`; if the env secret is not configured the
  route fails closed with `503`. Tokens are never logged or echoed back
  (SHA-256 digest compare — token length is not timing-observable;
  token-free error bodies).
- For `wrangler dev`, set both in `.dev.vars` (see `.dev.vars.example`);
  vitest injects test-only values via `vitest.config.ts`.
- `wrangler dev` binds **localhost only**. Deploying the Worker to the
  public internet requires an auth review first — checklist: token
  rotation, TLS, and a dedicated rotated secret for the Artifacts event
  subscription on `/events/artifacts` (today the sidecar shared bearer
  stands in for it).

## Routes

| Route | Auth | Meaning |
| --- | --- | --- |
| `POST /setup` | admin | create canonical repo (idempotent) |
| `POST /tasks` | admin | `{agent, intent?, base_sha?, ttlSeconds?}` — fork canonical, mint write token; records base_sha + intent |
| `POST /events/push` | agent token \| admin \| sidecar | `{agent\|fork, ref?, sha}` — WIP head; sha must be a real commit in the fork; dedups per (agent, sha), bounded ring |
| `POST /events/artifacts` | sidecar \| admin | documented `cf.artifacts.repo.pushed` envelope → same handler |
| `POST /checks` | runner | `{vector, policy, coverage?, results:[{pair,status,kind?,evidence?}]}` — vector must equal current heads (stale → 409); warnings only for `conflict` |
| `GET /status` | — | canonical, agents, head vector, per-pair radar status, warnings, radar log, last runner report |
| `GET /tasks/:id` | — | base_sha, intent, head, pushes, warnings + acks, testProvenance |
| `POST /tasks/:id/tests` | task's agent \| admin | `{command, exit, head_sha}` — attach test provenance (evidence gate) |
| `POST /warnings/:id/ack` | acking agent \| admin | `{agent, note?}` — record who acknowledged which warning at which head; cross-agent acks are 403 |

## Architecture

Provider-neutral facade since CONTRACT 0.1.4 (details in
[ARCHITECTURE.md](./ARCHITECTURE.md)): the coordination logic lives in
`src/core/` (pure TypeScript over `src/ports/` interfaces — GitHost,
CoordinationStore, PushEvents, Clock/Ids), and Cloudflare is one set of
adapters. A zero-dependency `node:http` runtime (`src/local/main.ts`)
serves the SAME routes from the SAME core; `npm run test:node` runs the
core suite with NO workerd.

```
              ┌──────────────────── Worker (src/index.ts) ───────────────────┐
  agent/      │  POST /tasks (admin)   POST /events/*   POST /checks (runner)│
  harness  ──►│        │                                       │             │
              │        └──────────────┬────────────────────────┘             │
              │              Durable Object RPC                            │
              └────────────────────────┼────────────────────────────────────┘
                                       ▼
        ┌── Coordinator DO (src/cloudflare/coordinator-do.ts, thin) ──┐
        │            CoordinatorCore (src/core/coordinator.ts)        │
        │  model (persisted via the CoordinationStore port)           │
        │  agents · heads · tasks · warnings/acks                     │
        │  pair checks · runner reports                               │
        │  Radar hook (src/radar.ts, StubRadar                        │
        │  reports not_checked — never a warning)                     │
        └───────────────┬─────────────────────────────────────────────┘
                        ▼  GitHost port (src/ports/githost.ts)
             ├─ RealArtifacts   ← Cloudflare Artifacts binding (src/artifacts/)
             └─ SidecarArtifacts ← local Node sidecar (src/local/githost.ts)

  trusted radar runner (L3, separate process, NOT the Worker)
      reads /status → does trial merges/tests locally → POST /checks

  local sidecar (prototype/local-artifacts/, Node built-ins + system git)
      real bare repos on disk · create = git init --bare + plumbing seed
      fork = git clone --bare (+ git update-ref to base_sha)
      smart HTTP via git http-backend · per-repo tokens (read can't push)
      post-receive hook → POST /events/push {fork, ref, sha}
```

- **CoordinatorCore** (single `"global"` DO instance in Cloudflare mode,
  all mutating methods serialized through a mutex): creates task forks,
  records pushes (verifying the sha against the real repo), maintains the
  head vector, invalidates warnings when a pair member advances, and
  records trusted runner results. State persists through the
  `CoordinationStore` port (DO storage in Cloudflare mode; memory/file in
  local mode); restart tests exist in BOTH runtimes
  (`evictDurableObject` in workerd, shared-store reconstruction in
  `test/node`).
- **Radar**: the in-Worker hook only logs pairs as `not_checked`. Warnings
  exist only for runner-submitted `conflict` results; `clean` at the same
  heads resolves a warning; `unknown` and `not_checked` (incl. stale
  checks after heads move) are always visibly distinct from `clean`.

## What is real vs deferred

| Piece | Local (today) | Real (account) |
| --- | --- | --- |
| Repo store | REAL bare git repos on disk via the sidecar | Cloudflare Artifacts repos |
| Git remotes | `http://127.0.0.1:8790/git/<name>.git` (smart HTTP) | `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<ns>/<repo>.git` |
| Tokens | sidecar-minted, same documented format `art_v1_<40hex>?expires=<unix>` | binding `createToken(scope, ttl)` — real service issues `art_v2_x_<40hex>?expires=<unix>`; tokens are OPAQUE, no prefix validation (spike finding 1) |
| Push events | sidecar post-receive hook → POST /events/push, plus manual/envelope routes | real agents `git push` + `cf.artifacts.repo.pushed` subscription → same handler (subscription wiring UNVERIFIED) |
| Commit verification | real (`git cat-file`) | `port.hasCommit` → binding `readCommit(sha)`; real commits carry `hash` + epoch-seconds instants, mapped to port types in `src/artifacts/map.ts` (spike finding B) |
| Fork at explicit base | real (`git update-ref` after bare clone) | binding cannot fork at a commit (CONFIRMED, spike F): forks default branch, waits for LIST-status readiness (bounded), records realized base = fork head (muse-r46 D3) |
| Trial merges/tests | trusted local runner (L3 lane), never the Worker | same (deployment boundary) |

Real-service evidence: `artifacts-spike/RESULTS.md` +
`appendix-transcript.md` on `origin/proto/artifacts-spike` (@ c75faa1,
29 ops against the real service, 2026-10-03). What is now CONFIRMED vs
still ASSUMED/UNVERIFIED for real mode is tabulated in CONTRACT.md 0.1.3.

API shapes come from the five official pages cited in
`docs-notes.md` (raw copies under `docs/`), corrected by the spike where
the docs were wrong (token format, commit fields, single-GET status);
anything beyond them is marked ASSUMED there (`ASSUMED-A`…`ASSUMED-G`).
Only documented binding operations
(create/fork/createToken/log/readCommit/list/delete) are used; no invented
merge or ref-enumeration APIs.

## Switch to real Artifacts (spike-validated path; PLAN-L1-REAL.md)

The real service was spike-validated end-to-end on 2026-10-03 (29 ops,
`origin/proto/artifacts-spike` @ c75faa1). Remaining switch steps:

1. Add the binding to `wrangler.jsonc` (documented shape):
   ```jsonc
   "artifacts": [{ "binding": "ARTIFACTS", "namespace": "agent-branches-dev" }]
   ```
   then `npx wrangler types` and reconcile the generated `Artifacts` type
   with the capability seam in `src/artifacts/real.ts` (commit field names
   are already handled by `src/artifacts/map.ts`; expect `expiresAt` vs
   REST's `expires_at` casing differences). This closes the binding-side
   type question (B) — DO visibility (D) still needs a running Worker.
2. Bootstrap from scripts goes through **REST** (`src/artifacts/rest.ts`):
   wrangler has `artifacts namespaces|repos list/get` but NO create/fork
   subcommands (spike finding 6). `ensureNamespace` is idempotent.
3. Seed the canonical repo: create it (binding or REST), then `git clone`
   its remote and push a real baseline commit
   (`git -c http.extraHeader="Authorization: Bearer $TOKEN" push`; keep the
   token out of argv/URLs — 0600 git-include pattern, spike-validated).
   Real tokens look like `art_v2_x_<40hex>?expires=<unix>` — treat them as
   opaque; a read-scope push fails with HTTP 400 (not 401/403).
4. Point an Artifacts event subscription (`artifacts.repo` source) at the
   deployed `POST /events/artifacts` route so real pushes flow in, and
   keep the bounded log-poll reconciliation (PLAN-L1-REAL §4) —
   subscription creation and delivery guarantees are still UNVERIFIED (E).
5. `npx wrangler deploy` (not authorized yet — competition rules — and
   subject to the auth review above).
