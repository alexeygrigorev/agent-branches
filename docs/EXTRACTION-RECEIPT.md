# Standalone Agent Branches Extraction Receipt

- Date: `2026-10-04T11:51:00Z`
- Target Workspace: `/home/alexey/git/agent-branches`
- Target Remote: `git@github.com:alexeygrigorev/agent-branches.git` (`https://github.com/alexeygrigorev/agent-branches`)
- Visibility: **Private**
- Extraction Executor: `ab-source-extractor` (`40ddf9b7-f7d8-4deb-8535-df3575e07182`)
- Integration Head: `antigravity-head` (`46fdb644-9b58-4e2f-aab3-9be5e1e33337`)

## Pinned Source Provenance

- Source Worktree: `/home/alexey/git/agent-branches-integration`
- Source Commit: `db4f6a8c398d69f0e19072c41cb4b453b7dd1b71`
- Source Tree SHA: `f31c6865d278e75ac6445717813c41d21210ccb5`
- Source Branch: `proto/integration-auth-matrix`
- Source Subject: `merge: combine proto/sdk-get-task-auth (cbf72e2) into proto/integration-auth-matrix`
- Source Committer Date: `2026-10-04T04:00:44+02:00`

## Extracted Product Paths

Total extracted product paths: **134** (detailed manifest in [SOURCE-PROVENANCE.md](file:///home/alexey/git/agent-branches/docs/SOURCE-PROVENANCE.md)).
Total tracked files in standalone repository: **142** (including bootstrap documentation, extraction provenance, extraction scripts, and safety guard).

Subsystems included:
1. `agent_branches/`: Python SDK client, CLI parser, git utilities.
2. `radar/`: Pre-push trial-merge and test conflict detection engine (`RadarEngine`).
3. `demo-target/`: Isolated Cloudflare-Worker-style shortlinks consumer service.
4. `prototype/`: Cloudflare Workers & Durable Objects coordinator, Git Smart HTTP sidecar daemon, ports, artifacts.
5. `live/`: Live demonstration harnesses, assertions, and checks.
6. `tests/`: End-to-end Python client, mock L1 server, admission, and radar unit tests.
7. `scripts/`: Safe synchronization script (`sync-main.sh`), secret scanner (`secret-scan.py`), extraction tooling (`extract-from-source.py`).

Excluded paths:
- Untracked local state (`prototype/local-coordinator-state.json`, `.env`, `.dev.vars`)
- Dependencies and caches (`node_modules/`, `__pycache__/`, `.build/`)
- Competition experiment journals, website, coordination files, and private logs.

## Remote Repository & Verification

- GitHub Remote: `git@github.com:alexeygrigorev/agent-branches.git`
- Remote Main SHA: `1196c8d919b4d51413402d3f6377820beb9914dd`
- Remote Tree SHA: `d882fe2aa9d0043ee93eb0f881861f5431d52342`
- Synchronization Script: `scripts/sync-main.sh` (fast-forward only, clean tree required, private paths forbidden).

## Security & Secret Scan

- Scanner: `python3 scripts/secret-scan.py`
- Result: **SECRET_SCAN_PASS** across 142 tracked files.
- Negative checks: Zero private keys, zero GitHub PATs, zero AWS keys, zero Slack/OpenAI tokens, zero hardcoded bearer credentials. All `.env`, `.local`, `live/evidence`, and uncommitted state excluded.

## Independent Remote Clone Restore Receipt

- Scratch Restore Directory: `/home/alexey/git/agent-branches/.local/restore/clone`
- Clone Command: `git clone git@github.com:alexeygrigorev/agent-branches.git .local/restore/clone`
- Clone Target: Independent remote GitHub clone (not local `file://` or worktree hardlink).
- Integrity Audit (`git fsck`): 100% clean, 0 corruptions, 0 dangling objects.
- HEAD Commit Match: `1196c8d919b4d51413402d3f6377820beb9914dd` (matches pushed remote main).
- HEAD Tree Match: `d882fe2aa9d0043ee93eb0f881861f5431d52342` (matches pushed remote tree).
- Remote Test Execution:
  `python3 -m unittest discover -s tests/`
  Result: **Ran 46 tests in 10.511s — OK (46/46 PASS)**.
