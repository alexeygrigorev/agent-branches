# Agent Branches

Agent-native Git coordination: concurrent agents work in forks of a canonical
repo, a coordinator tracks WIP heads, and a trusted radar runner reports
conflict warnings.

This repository is the **standalone product source** (Python SDK/CLI, radar,
TypeScript coordinator/sidecar, UI facade, demo workspace). It is a private
GitHub backup of selected product files. It is not a mirror of the experiment
log history.

Pinned from `/home/alexey/git/agent-branches-integration` commit
`db4f6a8c398d69f0e19072c41cb4b453b7dd1b71` (tree
`f31c6865d278e75ac6445717813c41d21210ccb5`). Exact path/blob map:
[docs/SOURCE-PROVENANCE.md](docs/SOURCE-PROVENANCE.md). Original license:
[LICENSE](LICENSE) (MIT).

## Layout

- `agent-branches` — executable CLI (`python3` launcher)
- `agent_branches/` — L2 Python SDK (`task`, `push`, `status`, `ack`, `checks`)
- `radar/` — L3 radar engine and RAM admission
- `prototype/` — coordinator Worker/DO, local `node:http` runtime, git sidecar, UI
- `live/` — end-to-end demo runner (tokens stay in untracked `live/.dev.vars`)
- `demo-target/` — sample agent workspace
- `tests/` — source-only Python tests (mock coordinator, radar, admission)
- `scripts/sync-main.sh` — fast-forward-only push of `main` to GitHub

HTTP contract: [prototype/CONTRACT.md](prototype/CONTRACT.md) (v0.1.4).
Coordinator architecture: [prototype/ARCHITECTURE.md](prototype/ARCHITECTURE.md).
Local prototype run: [prototype/README.md](prototype/README.md).
Live demo: [live/README.md](live/README.md).

## Python SDK / CLI

```bash
./agent-branches --help
python3 -m agent_branches --help

# source-only tests (no network install)
python3 -m unittest tests.test_client tests.test_admission tests.test_radar_engine
```

Default coordinator URL is `$AGENT_BRANCHES_SERVER` or `http://127.0.0.1:8787`.

## Prototype coordinator (optional)

Requires a local Node install. Do not copy `node_modules` into this repo.

```bash
cd prototype
npm install          # operator machine only; not part of the source backup
npm run typecheck
npm run test:sidecar
# wrangler/vitest suites need those devDependencies
```

Copy `prototype/.dev.vars.example` to `prototype/.dev.vars` (gitignored) for
local tokens. Never commit `.env`, `.dev.vars`, or `local-coordinator-state.json`.

## GitHub backup

```bash
scripts/sync-main.sh
```

The script pushes `main` only, refuses force, refuses dirty/private files, and
logs source SHA vs remote SHA under `.local/raw/`.
