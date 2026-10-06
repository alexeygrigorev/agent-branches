# Execution Receipt: Agent Branches Sync Verification (C2786)

## Objective
Verify the standalone Agent Branches `sync-main.sh` script enforcing `git --isolated --owned-path` properties in `/home/alexey/git/agent-branches`. Negative tests were executed to validate proper fail-closed behavior for secrets (isolated), unauthorized paths (owned-path), and history conflicts.

## Methodology
Tests were executed in an ephemeral test clone within `.local/tmp/test-repo` to avoid modifying the checked-out workspace state. The `scripts/sync-main.sh` was invoked against manipulated repository configurations and states.

### Negative Tests

1. **Unauthorized Paths (Owned-Path Check)**
   - **Condition:** Executed sync with the repository origin pointing to a local or unauthorized URL.
   - **Expectation:** Fail-closed.
   - **Result:** **PASS**. The script strictly validates `origin_url` against `alexeygrigorev/agent-branches.git` and correctly exited:
     `ERROR: origin is not alexeygrigorev/agent-branches: /home/alexey/git/agent-branches`

2. **Secrets (Isolated Check - Dirty & Tracked)**
   - **Condition A (Dirty):** Forced an ignored `.env` file into a dirty state by staging it.
   - **Result A:** **PASS**. Failed pre-flight index checks before initiating fetch/push:
     `ERROR: refusing sync; private or excluded path is dirty: .env`
   - **Condition B (Tracked):** Force-added and committed `.env` to the history.
   - **Result B:** **PASS**. Bypassed dirty checks but failed the explicit `git ls-files` tracker trap:
     `ERROR: refusing sync; private files are tracked: .env`

3. **Conflict Fail-Closed**
   - **Condition:** Simulated divergent history by creating a non-fast-forward local commit on `main` while `origin/main` was concurrently advanced. Network `fetch`/`push` commands were mocked to prevent actual side-effects.
   - **Expectation:** Fail-closed without initiating `--force`.
   - **Result:** **PASS**. Failed on ancestor verification:
     `ERROR: refusing non-fast-forward sync. local=15b5d03... remote=80a0ce0... source=db4f6a8c398d69f0e19072c41cb4b453b7dd1b71`

## Conclusion
The `scripts/sync-main.sh` successfully enforces `--isolated` (secret tracking rejection) and `--owned-path` (remote validation and dirty state rejection) properties, operating as a strict fail-closed state machine. No force-pushes or unauthorized extractions are permitted.
