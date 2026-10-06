# Independent Code & Negative-Test Review: Isolated Owned-Path Sync Preview Contract Regression Fix

- **Reviewer**: Independent Code & Negative-Test Reviewer (Antigravity Subagent)
- **Reviewer Conversation ID**: `ae41c990-e7f8-4889-9f24-f72f111cee16`
- **Date**: 2026-10-06
- **Audited Commit**: `772ba30d71ba75cf2b129a0c44f62726b5ebcb5b` (`772ba30`)
- **Base Commit**: `1f55453cb1c1d81fb1ca09ba477a339a73bb61ec` (`1f55453`)
- **Target Repository**: `/home/alexey/git/agent-branches`
- **Audited Files**:
  - `agent_branches/sync_git.py` (`sync_isolated_owned_paths`)
  - `agent_branches/cli.py` (`handle_sync_git`)
  - `tests/test_sync_git.py` (`TestSyncGit`)
- **Final Verdict**: **ACCEPTED**

---

## 1. Executive Summary & Root Cause Analysis (C2798)

In commit `3da93b6`, isolated owned-path synchronization was introduced to allow multi-agent teams sharing a single working tree to synchronize distinct owned paths directly to remote Git tips without mutating shared checkout `HEAD` or `.git/index`. However, issue **C2798** revealed a critical preview contract violation:

### 1.1 Root Cause of C2798
1. **Argument Dropping in CLI**: In `agent_branches/cli.py`, `handle_sync_git` extracted `preview = bool(getattr(args, "preview", False))`, but when invoking `sync_isolated_owned_paths(...)`, it failed to forward the `preview` flag.
2. **Missing Preview Parameter in Core Logic**: In `agent_branches/sync_git.py`, `sync_isolated_owned_paths` did not define or accept a `preview` parameter.
3. **Severe Contract Violation**: Whenever an operator or automated agent executed `agent-branches sync git --owned-path <path> --preview`, the command unexpectedly executed the full live sync pipeline: calling `git write-tree`, `git commit-tree`, and `git push`, thereby publishing real commits to the remote branch and writing checkpoint references (`refs/checkpoints/...`) on push failure.

A dry-run / preview command MUST strictly guarantee read-only semantics: it must never publish commits, modify remote references, create local checkpoint refs, or mutate working tree files.

Commit `772ba30` thoroughly fixes this regression, establishing strict preview enforcement in both the library function and the CLI, backed by comprehensive negative unit tests.

---

## 2. Code Verification of Fix

### 2.1 Core Implementation (`agent_branches/sync_git.py`)

In `sync_isolated_owned_paths`:
- **Function Signature**: Added `preview: bool = False` keyword argument (line 573).
- **Pre-flight Divergence & Collision Verification**: Pre-flight verification (fetch, divergence check, and divergent collision detection against remote changes) continues to execute. This ensures that preview mode accurately surfaces whether the sync would succeed or abort with a conflict if executed for real.
- **Isolated Index Staging**: Stages the owned paths into an ephemeral temporary index (`temp_idx`, created via `tempfile.mkstemp(prefix="git_idx_isolated_")` with `GIT_INDEX_FILE` in the subprocess environment) against `base_parent_sha`.
- **No-Op Detection**: If `git diff-index --cached --quiet` indicates no differences between the staged isolated index and `base_parent_sha`, it returns `status: "noop"` with `shared_checkout_advanced: False`.
- **Preview Intercept (Lines 740–768)**:
  ```python
  # Preview mode check: if preview is True, do NOT write tree, commit, push, or create checkpoint refs!
  if preview:
      res_diff_stat = subprocess.run(
          ["git", "diff-index", "--cached", "--name-status", base_parent_sha],
          cwd=str(repo_path),
          env=env,
          capture_output=True,
          text=True,
          timeout=SUBPROCESS_TIMEOUT_SEC,
          check=False,
      )
      diff_lines = res_diff_stat.stdout.strip().splitlines() if res_diff_stat.returncode == 0 else []
      return {
          "status": "preview",
          "branch": target_branch,
          "remote": remote,
          "remote_sha": rem_sha,
          "shared_checkout_head": head_sha,
          "shared_checkout_advanced": False,
          "owned_paths": normalized_owned,
          "staged_in_isolated_index": normalized_owned,
          "diff_summary": diff_lines,
          "in_sync": False,
          "verified": True,
          "message": (
              f"Preview mode: {len(normalized_owned)} owned path(s) would be committed against remote tip {base_parent_sha[:8]}. "
              "No commit created, no push attempted, no checkpoint ref created."
          ),
      }
  ```
- **Strict Execution Isolation**:
  - The return occurs *before* any calls to `git write-tree` (line 771), `git commit-tree` (line 786), `git push` (line 801), or `git update-ref` (lines 814, 845).
  - The `finally:` block at line 888 guarantees `temp_idx.unlink(missing_ok=True)`, immediately cleaning up the temporary index file.
  - Remote tip, local checkout `HEAD`, shared `.git/index`, and all working tree files remain 100% untouched.

### 2.2 CLI Layer Verification (`agent_branches/cli.py`)

In `handle_sync_git`:
- **Argument Forwarding**: `preview=preview` is explicitly passed to `sync_isolated_owned_paths` (line 728).
- **Human Output Formatting**:
  ```python
  if status == "preview":
      print(f"[PREVIEW] Isolated owned-path sync preview for branch: {res.get('branch')}")
      print(f"  Target Remote Tip: {res.get('remote_sha')}")
      print(f"  Shared Checkout HEAD: {res.get('shared_checkout_head')} (unmodified: True)")
      print(f"  Owned Paths to Commit ({len(res.get('owned_paths', []))}):")
      for p in res.get("owned_paths", []):
          print(f"    {p}")
      for line in res.get("diff_summary", []):
          print(f"    diff: {line}")
      print(f"  {res.get('message')}")
      return 0
  ```
- **JSON Output**: When `--json` is specified, outputs the full dictionary with indent formatting.
- **Exit Code**: Clean exit code `0` is returned via:
  ```python
  return 0 if (res.get("in_sync") or res.get("status") in ("synced", "noop", "preview")) else 1
  ```

---

## 3. Negative-Test and Positive-Test Verification

Two rigorous tests were added to `tests/test_sync_git.py` covering both unit logic and CLI dispatch:

### 3.1 Negative Test: `test_sync_isolated_owned_paths_preview_mode_does_not_commit_or_push`
- **Scenario**:
  1. Base commit created and pushed to origin remote; initial `HEAD` and remote SHA recorded.
  2. Working tree receives modifications to owned file (`owned_preview.txt`) AND an uncommitted peer dirty file (`peer_dirty.txt`).
  3. Executes `sync_isolated_owned_paths(..., preview=True)`.
- **Negative Invariant Assertions**:
  - `status == "preview"`, `shared_checkout_advanced == False`, `in_sync == False`, `verified == True`.
  - Local checkout `HEAD` is unchanged (`current_head == initial_head`).
  - Peer dirty file is untouched in working tree (`?? peer_dirty.txt` in porcelain status).
  - Remote tip was NOT mutated (`remote_after == remote_before`).
  - Zero checkpoint refs created (`git for-each-ref refs/checkpoints/` returns empty).

### 3.2 Negative vs. Positive Comparison: `test_cli_sync_git_isolated_preview_mode`
- **Phase 1 (Preview Negative Test)**:
  - Invokes CLI with `["sync", "git", "--owned-path", "cli_preview_doc.txt", "--preview", "--json"]`.
  - Asserts exit code `0`, `status == "preview"`, `shared_checkout_advanced == False`.
  - Asserts remote tip is completely unmutated (`remote_after == remote_before`).
- **Phase 2 (Positive Non-Preview Comparison)**:
  - Invokes CLI with `["sync", "git", "--owned-path", "cli_preview_doc.txt", "--json"]` (omitting `--preview`).
  - Asserts exit code `0`, `status == "synced"`, `verified == True`.
  - Asserts remote tip advances to `res["published_commit"]` (`remote_synced != remote_before`).

---

## 4. Test Suite Execution & Output Summary

Targeted test execution was performed directly on `tests/test_sync_git.py`:

```bash
cd /home/alexey/git/agent-branches && PYTHONPATH=. pytest -v tests/test_sync_git.py
```

### Execution Results:
```text
============================= test session starts ==============================
platform linux -- Python 3.12.3, pytest-9.1.1, pluggy-1.6.0 -- /usr/bin/python3
cachedir: .pytest_cache
rootdir: /home/alexey/git/agent-branches
plugins: anyio-4.12.1, opik-2.2.54
collected 25 items

tests/test_sync_git.py::TestSyncGit::test_clean_ahead_push_timeout_handling PASSED [  4%]
tests/test_sync_git.py::TestSyncGit::test_clean_ahead_pushes_to_remote PASSED [  8%]
tests/test_sync_git.py::TestSyncGit::test_cli_sync_git_isolated_mode PASSED [ 12%]
tests/test_sync_git.py::TestSyncGit::test_cli_sync_git_isolated_preview_mode PASSED [ 16%]
tests/test_sync_git.py::TestSyncGit::test_forbidden_file_ignored_during_sync PASSED [ 20%]
tests/test_sync_git.py::TestSyncGit::test_forbidden_patterns PASSED      [ 24%]
tests/test_sync_git.py::TestSyncGit::test_get_remote_sha_timeout_fail_closed PASSED [ 28%]
tests/test_sync_git.py::TestSyncGit::test_noop_when_clean_and_in_sync PASSED [ 32%]
tests/test_sync_git.py::TestSyncGit::test_porcelain_z_special_character_paths PASSED [ 36%]
tests/test_sync_git.py::TestSyncGit::test_pre_staged_new_forbidden_patterns_rejected PASSED [ 40%]
tests/test_sync_git.py::TestSyncGit::test_pre_staged_secret_rejected PASSED [ 44%]
tests/test_sync_git.py::TestSyncGit::test_preview_mode PASSED            [ 48%]
tests/test_sync_git.py::TestSyncGit::test_push_failure_preserves_local_checkpoint PASSED [ 52%]
tests/test_sync_git.py::TestSyncGit::test_push_timeout_handling_returns_unpushed_checkpoint PASSED [ 56%]
tests/test_sync_git.py::TestSyncGit::test_remote_mismatch_returns_push_unverified PASSED [ 60%]
tests/test_sync_git.py::TestSyncGit::test_repo_lock_concurrency PASSED   [ 64%]
tests/test_sync_git.py::TestSyncGit::test_sync_commit_and_push_verified PASSED [ 68%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_divergent_collision_fail_closed PASSED [ 72%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_missing_owned_path PASSED [ 76%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_noop PASSED [ 80%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_preview_mode_does_not_commit_or_push PASSED [ 84%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_push_rejection_preserves_checkpoint PASSED [ 88%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_secret_forbidden PASSED [ 92%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_success_and_shared_checkout_untouched PASSED [ 96%]
tests/test_sync_git.py::TestSyncGit::test_whitelisted_env_example_can_be_synced PASSED [100%]

============================== 25 passed in 3.40s ==============================
```

All 25 tests passed cleanly with zero failures or warnings.

---

## 5. Review Criteria Checklist

| Requirement / Invariant | Status | Evidence |
| :--- | :--- | :--- |
| `preview: bool = False` in `sync_isolated_owned_paths` | **VERIFIED** | Present in function signature (`agent_branches/sync_git.py:573`) |
| Preview mode never calls `write-tree`, `commit-tree`, `push`, `update-ref` | **VERIFIED** | Intercept block returns early at lines 741–768 before write/push operations |
| Ephemeral isolated index cleaned up on exit | **VERIFIED** | `finally: temp_idx.unlink(missing_ok=True)` at line 888 |
| Shared checkout `HEAD`, index, dirty files untouched | **VERIFIED** | Validated in unit test assertions against porcelain status & `git rev-parse HEAD` |
| Remote tip unmodified during preview | **VERIFIED** | Asserted in both direct API test and CLI test (`remote_after == remote_before`) |
| Zero checkpoint refs created in preview mode | **VERIFIED** | Asserted via `git for-each-ref refs/checkpoints/` |
| CLI `--preview` flag forwarded to `sync_isolated_owned_paths` | **VERIFIED** | Passed at line 728 in `agent_branches/cli.py` |
| CLI preview human and JSON output formatting | **VERIFIED** | Implemented at lines 734–745 in `agent_branches/cli.py` |
| CLI preview exit code 0 | **VERIFIED** | Implemented at line 775 in `agent_branches/cli.py` |
| Negative test cases present and passing | **VERIFIED** | `test_sync_isolated_owned_paths_preview_mode_does_not_commit_or_push` PASSED |
| Positive non-preview comparison present and passing | **VERIFIED** | `test_cli_sync_git_isolated_preview_mode` PASSED |
| Targeted test suite passes (25 tests) | **VERIFIED** | 25 passed in 3.40s |

---

## 6. Final Verdict

**ACCEPTED**. Commit `772ba30` rigorously enforces the preview contract for isolated owned-path synchronization, completely eliminates the C2798 contract violation, preserves all safety and non-mutation invariants, and provides robust test coverage.
