# Receipt: Branches Sync Dogfood CLI Integration (C2897)

- **Task ID**: `t-branches-dogfood-cli-c2897`
- **Target Repository**: `agent-branches` (`git@github.com:alexeygrigorev/agent-branches.git`)
- **Target Commit**: `969d682` (`feat(cli): add sync dogfood command to run 3-stage validation pipeline`)
- **Timestamp**: `2026-10-06T15:29:30Z`
- **Head Session**: `ant-head-never-timer-custody-20261006` (`7d87f36b-8d02-4b46-8216-98d6dce3f990`)
- **Assigned Reviewer**: `t-branches-review-dogfood-cli-c2897`

---

## 1. Architectural Summary

Following `SCALE50-RECOVERY-PLAN.md` (Stream 3 / task `scale50-B`), the 3-stage dogfood branches sync pipeline ([`scripts/dogfood_branches_sync.py`](file:///home/alexey/git/agent-branches/scripts/dogfood_branches_sync.py)) is now directly exposed and executable via the public CLI:

```bash
branches sync dogfood [--json]
```

### Verified 3-Stage Pipeline Guarantees:
1. **Stage 1 (Preview Mode)**:
   - Evaluates changes in memory and temporary index.
   - Strictly asserts zero mutations to remote branches, zero local checkout HEAD movement, and zero dangling checkpoint refs created.
2. **Stage 2 (Isolated Push)**:
   - Uses plumbing-isolated index (`GIT_INDEX_FILE` tempfile) and commit tree generation (`git write-tree` / `git commit-tree`).
   - Pushes directly to the remote refspec without advancing the local checkout HEAD.
   - Guarantees zero contamination of uncommitted peer dirty files.
3. **Stage 3 (Remote Recovery)**:
   - Clones cleanly from the pushed remote ref into an isolated detached worktree.
   - Cryptographically verifies byte-for-byte SHA-256 match against source files.
   - Strictly verifies that dirty/uncommitted peer files were not pushed or leaked.

---

## 2. Test Execution Evidence

- **Targeted Unit Tests (`tests/test_dogfood_sync.py`)**:
  * `test_dogfood_branches_sync_pipeline_end_to_end`: PASSED
  * `test_cli_sync_dogfood`: PASSED
  * **Result**: **2/2 passed** in 0.30s.

- **Full Targeted Suite**: **43/43 passed** across `tests/test_dogfood_sync.py`, `tests/test_roster.py`, `tests/test_sync_git.py`, `tests/test_bus.py`, `tests/test_cli_bus.py`, and `tests/test_history_preserve.py`.

---

## 3. Quota Launcher Integration

- Task registered in SQLite store (`~/.config/agent-quota-launcher/state.db`):
  * ID: `t-branches-dogfood-cli-c2897`
  * State: `completed-awaiting-review`
  * Reviewer: `t-branches-review-dogfood-cli-c2897`
  * Paths: `agent_branches/cli.py`, `tests/test_dogfood_sync.py`
