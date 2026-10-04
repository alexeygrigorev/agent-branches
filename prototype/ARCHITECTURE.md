# Agent Branches prototype — architecture (ports & adapters)

version marker: CONTRACT 0.1.4 (docs-only; the wire is unchanged since 0.1.2)

The Cloudflare integration is a **facade**: ALL coordination logic — task
registry, head vectors, push dedup, warnings, checks validation, the
stale-vector rule, auth decisions — lives in `src/core/` as pure TypeScript
and depends ONLY on the provider-neutral ports in `src/ports/`. Cloudflare
is one set of adapters (`src/cloudflare/`); a plain Node runtime is another
(`src/local/`). If the project ever needs to run on a different git host,
store or HTTP platform, the core does not change.

```
                 ┌────────────────────────────────────────────┐
                 │                src/core/                   │
                 │  CoordinatorCore   (state machine + rules) │
                 │  router.handleRoute (wire, CONTRACT.md)    │
                 │  auth decisions    (fail-closed, hashed)   │
                 └──────┬───────────┬───────────┬─────────────┘
                        │ uses ONLY │           │
                 ┌──────▼──────┐ ┌──▼────────┐ ┌▼──────────────┐
                 │ src/ports/  │ │ src/radar │ │ src/checks-wire│
                 │ GitHost     │ │ .ts (pure)│ │ .ts (pure)    │
                 │ Coordination│ └───────────┘ └───────────────┘
                 │ Store       │
                 │ PushEvents  │
                 │ Clock / Ids │
                 └───┬─────┬───┘
        ┌────────────┘     └───────────────┐
┌───────▼────────────┐          ┌──────────▼──────────┐
│ src/cloudflare/    │          │ src/local/          │
│ Coordinator (DO)   │          │ node:http runtime   │
│ DO storage store   │          │ memory/file store   │
│ Artifacts GitHost  │          │ sidecar GitHost     │
│ Artifacts PushEvts │          │ webhook PushEvents  │
└────────────────────┘          └─────────────────────┘
```

## Ports (src/ports/)

| Port | Purpose | Cloudflare adapter | Local adapter |
| --- | --- | --- | --- |
| `GitHost` | createRepo, fork, mintToken{scope,ttl}, headCommit, log, hasCommit, listRepos, deleteRepo, optional `unprocessedPushes()` | `RealArtifacts` (the Artifacts binding, `src/artifacts/real.ts` — unchanged) selected by `gitHostFromEnv` | `SidecarArtifacts` (`src/local/githost.ts`), the local git sidecar |
| `CoordinationStore` | transactional get/put of the coordinator state; linearizable visibility, writers serialized by the core's mutex | `DurableObjectCoordinationStore` (DO storage) | `MemoryCoordinationStore` / `FileCoordinationStore` (tmp+rename atomic) |
| `PushEvents` | normalize ANY incoming push notification into one `PushEvent` | `directPushEvents` (agents + webhook JSON), `artifactsPushEvents` (`cf.artifacts.repo.pushed` envelope) | `webhookPushEvents` (post-receive shape), `localArtifactsPushEvents` (envelope parity) |
| `Clock` / `IdGenerator` | time and identity, injectable for tests | `systemClock` / `cryptoIds` (Web-standard globals) | same defaults |

`GitHost` is the former `ArtifactsPort`, renamed with zero behavior change;
`ArtifactsPort` remains as a deprecated alias. `src/types.ts` and
`src/coordinator.ts` are pure re-export shims so pre-facade import paths
(including the existing test suite) keep working.

## Core (src/core/)

- `model.ts` — the persisted state shape (`CoordinatorModel`) plus
  record types and load-time migration. One store key (`"model"`).
- `coordinator.ts` — `CoordinatorCore`: every rule, moved verbatim from the
  pre-facade Durable Object class. Mutating methods are serialized by an
  in-class mutex (codex C-1305 #4); storage goes through the port.
- `auth.ts` — pure auth decisions: fail closed on unconfigured secrets,
  SHA-256 both sides before constant-time compare (token length is not
  observable), agent tokens verified by stored digest, cross-agent writes
  are 403 (not 401). Tokens are never logged or echoed.
- `router.ts` — THE one implementation of every HTTP route (CONTRACT.md).
  `handleRoute` maps a neutral `HttpRequest` to a neutral `HttpResponse`
  `{status, body}`; adapters serialize the body as pretty JSON with
  `content-type: application/json`. Error→status mapping is copied
  verbatim from the pre-facade Worker.

`src/radar.ts` and `src/checks-wire.ts` are already pure TypeScript and
stay at their established paths; the core imports them directly.

## Adapters

### Cloudflare (`src/cloudflare/`)

- `coordinator-do.ts` — the `Coordinator` Durable Object; thin passthrough
  methods with the SAME signatures as pre-facade (typed RPC unchanged).
  Wires `DurableObjectCoordinationStore` + `gitHostFromEnv`.
- `worker.ts` — maps `Request`/`Response` onto the neutral view and
  delegates to `handleRoute`. Route behavior is byte-identical.
- `do-store.ts`, `githost.ts`, `push-events.ts`, `env.ts` — the four
  adapters and env typings. Deployment boundary unchanged (codex C-1309):
  the Worker/DO never runs git.

One documented assertion lives in `worker.ts`: the DO RPC stub's TYPE
mapping widens tuples (`[string, string]` → `string[]`) even though
structured clone preserves them at runtime; the stub is asserted to
`CoordinatorAccess` at that single boundary instead of widening core types.

### Local (`src/local/`)

- `runtime.ts` — `serveCoordinator`: real `node:http` server serving the
  same routes from the same core. No workerd, no Cloudflare.
- `main.ts` — standalone entry: `LOCAL_ARTIFACTS_URL`, `ADMIN_TOKEN`,
  `RUNNER_TOKEN`, `LOCAL_ARTIFACTS_TOKEN`, `RADAR_IMPL`, `PORT`, `HOST`,
  `COORDINATOR_STATE_FILE` (same env names as the Worker where they
  overlap). Persists to a JSON file by default.
- `githost.ts` (moved `SidecarArtifacts`), `store.ts`, `push-events.ts`.
- `node-globals.d.ts` — minimal ambient Node typings; combined with
  `types/node-web.d.ts` (node build ONLY) the repo still has **zero**
  `@types/*` / runtime npm dependencies.

## Tests

| Suite | Command | Runtime |
| --- | --- | --- |
| Worker + DO end-to-end | `npm test` | vitest + workerd + real-git sidecar |
| Sidecar (bare git repos) | `npm run test:sidecar` | plain `node --test` |
| Core + router + local adapters | `npm run test:node` | plain `node --test` (NO workerd) against in-memory fakes and a real node:http server |
| Everything | `npm run test:all` | typecheck + all three |

`test/node/architecture.test.ts` FAILS if any file under `src/core/` or
`src/ports/` imports a Cloudflare-specific module (`cloudflare:*`,
`@cloudflare/*`, `workers-types`, `wrangler`), with a positive control so
the gate cannot rot silently. Structurally, `tsconfig.node.json` compiles
the core WITHOUT `worker-configuration.d.ts` — a transitive Cloudflare
dependency would not even typecheck there.

## How to add another provider

- **Gitea/GitHub GitHost** — implement `GitHost` (map their REST to
  `createRepo`/`fork`/`mintToken`/`log`/`headCommit`/`hasCommit`), add a
  `PushEvents` normalizer for their webhook envelope, register it in the
  runtime composition (`gitHostFromEnv` for Cloudflare, `startLocalRuntime`
  for Node). No core change; the architecture test keeps it honest.
- **Postgres/Redis store** — implement `CoordinationStore` with the same
  linearizable get/put semantics (the core serializes writers already).
  Migrations for old states live in `core/model.ts:migrateStoredModel`.
- **Another HTTP platform** — translate its request to `HttpRequest`,
  call `handleRoute`, serialize `HttpResponse`. Auth/routing logic is
  already platform-free.
