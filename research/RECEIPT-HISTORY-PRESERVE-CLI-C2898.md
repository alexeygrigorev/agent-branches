# Receipt: Bounded History Preservation CLI Integration (C2898)

- **Task ID**: `t-branches-history-cli-c2898`
- **Target Repository**: `agent-branches` (`git@github.com:alexeygrigorev/agent-branches.git`)
- **Target Commit**: `f060c7e` (`feat(cli): add history preserve command for bounded session archiving`)
- **Timestamp**: `2026-10-06T15:36:00Z`
- **Head Session**: `ant-head-never-timer-custody-20261006` (`7d87f36b-8d02-4b46-8216-98d6dce3f990`)
- **Assigned Reviewer**: `t-branches-review-history-cli-c2898`

---

## 1. Architectural Summary

Following maintainer friction intake C2889 and recovery governance, bounded session history and pending state preservation ([`agent_branches/history_preserve.py`](file:///home/alexey/git/agent-branches/agent_branches/history_preserve.py)) is now directly exposed and executable via the public CLI:

```bash
branches history preserve --session-id <session_id> --output-dir <target_dir> [--state-dir <state_dir>] [--max-bytes <bytes>] [--json]
```

### Key Guarantees Enforced:
1. **Bounded Storage Budget**: Enforces a strict storage budget ceiling (default 50 MiB, configurable via `--max-bytes`). Fails closed with `BudgetExceededError` if session data exceeds the budget.
2. **Private File Permissions**: Creates target archive directory with `0700` (`rwx------`) permissions and copies archive files with `0600` (`rw-------`) permissions.
3. **Scope Isolation**: Restricts copying strictly to declared session files (`history.bin` and `preservation_metadata.json`). Never duplicates global mailbox queues or unrelated session history.
4. **Path Traversal Protection**: Rejects directory traversal attempts in session identifiers (`..` or slash prefixes) fail-closed.
5. **Standard Exit Codes & JSON Output**: Returns exit code 0 on successful preservation; returns exit code 1 on failure. Supports machine-readable `--json` formatting.

---

## 2. Test Execution Evidence

- **Targeted Unit Tests (`tests/test_history_preserve.py`)**:
  * `test_preserve_session_history_success`: PASSED
  * `test_preserve_session_history_session_not_found`: PASSED
  * `test_preserve_session_history_budget_exceeded`: PASSED
  * `test_preserve_session_history_path_traversal_rejected`: PASSED
  * `test_cli_history_preserve_success`: PASSED
  * **Result**: **5/5 passed** in 0.04s.

- **Full Targeted Suite**: **44/44 passed** across `tests/test_history_preserve.py`, `tests/test_dogfood_sync.py`, `tests/test_roster.py`, `tests/test_sync_git.py`, `tests/test_bus.py`, and `tests/test_cli_bus.py`.

---

## 3. Quota Launcher Integration

- Task registered in SQLite store (`~/.config/agent-quota-launcher/state.db`):
  * ID: `t-branches-history-cli-c2898`
  * State: `completed-awaiting-review`
  * Reviewer: `t-branches-review-history-cli-c2898`
  * Paths: `agent_branches/cli.py`, `tests/test_history_preserve.py`
