# Independent Code & Negative-Test Review: CLI Exposure & Divergent Collision Fail-Closed Mode

- **Reviewer**: Independent Code & Negative-Test Reviewer (Antigravity Subagent)
- **Reviewer Conversation ID**: `5545d139-b4ea-44cf-a747-364d00c5ed33`
- **Date**: 2026-10-06
- **Audited Commit**: `3da93b60aa487a1c50ecc2639c54ad9064f2489f` (`3da93b6`)
- **Base Commit**: `723fc388b03063462828b61c97a5c898c0b57e7f` (`723fc38`)
- **Target Repository**: `/home/alexey/git/agent-branches`
- **Audited Files**:
  - `agent_branches/cli.py` (`git_sync` subparser, `handle_sync_git`)
  - `agent_branches/sync_git.py` (`sync_isolated_owned_paths`)
  - `tests/test_sync_git.py` (`TestSyncGit`)
- **Final Verdict**: **ACCEPTED**

---

## 1. Executive Summary & Context

Commit `3da93b6` in `/home/alexey/git/agent-branches` resolves the key qualifications and ergonomic limitations identified during the initial rollout of the isolated owned-path sync subsystem (reviewed in `REV-ISOLATED-OWNED-PATH-SYNC-20261006.md`).

Specifically, this commit:
1. **Exposes Isolated Owned-Path Sync to the CLI**: Surfaces `--owned-path` (repeatable and comma-separable), `--isolated` (flag), and `--branch` in `agent-branches sync git`, backed by structured JSON and human-readable reporting across all outcome states (`synced`, `noop`, `conflict`, `unpushed_checkpoint`, `push_unverified`).
2. **Implements Fail-Closed Divergent Collision Detection**: Pre-emptively identifies concurrent remote modifications on the owned paths via Git merge-base and tree-diff analysis before constructing commits, aborting immediately with `status: "conflict"` and providing actionable recovery instructions while leaving working tree, index, and local checkout `HEAD` untouched.
3. **Creates Durable Checkpoint References (`refs/checkpoints/...`)**: Eliminates dangling unreferenced commits on push rejection or push timeout by writing a persistent ref under `refs/checkpoints/isolated-<branch>-<timestamp>` via `git update-ref`, complete with explicit `restore_instructions`.
4. **Validates Invariants with Negative Tests**: Extends the unit test suite with multi-agent simulation fixtures validating concurrent remote modifications, peer dirty working tree preservation, durable checkpoint ref tracking, and CLI invocation.

---

## 2. CLI Exposure & User Workflow Analysis

### 2.1 Subparser Arguments (`agent_branches/cli.py`)
In `build_parser()` (lines 386–404), the `sync git` subparser was extended with:
- `--branch`: Specifies target branch for synchronization (defaults to current branch).
- `--owned-path`: Repeatable (`action="append"`, `dest="owned_paths"`) argument allowing agents and operators to designate one or more owned files/directories.
- `--isolated`: Explicit flag enabling isolated mode without mutating shared checkout `HEAD` or index.
- `--json`: Flag enabling machine-readable JSON output for automated scripting and multi-agent coordination.

### 2.2 Dispatch and Argument Normalization (`handle_sync_git`)
In `handle_sync_git()` (lines 693–770):
- **Path Normalization**: Iterates over `args.owned_paths`, splits comma-delimited strings, strips whitespace, and compiles `owned_paths`.
- **Mode Dispatch**: Automatically routes to `sync_isolated_owned_paths` if either `owned_paths` or `--isolated` is supplied.
- **Fail-Closed Validation**: If `--isolated` is set without any `--owned-path`, the CLI aborts immediately with an error message and exit code `1` (`"Isolated sync mode requires at least one path via --owned-path"`).
- **Execution & Formatting**:
  - `synced`: Prints formatted summary including branch, published commit, remote SHA verification, unmodified shared checkout HEAD confirmation, and owned paths list. Returns exit code `0`.
  - `noop`: Prints clean no-op status with remote SHA. Returns exit code `0`.
  - `conflict`: Prints `[CONFLICT]` along with colliding paths, remote divergence error, and recovery instructions to `sys.stderr`. Returns exit code `1`.
  - `unpushed_checkpoint`: Prints `[UNPUSHED CHECKPOINT]` with branch, preserved commit SHA, durable checkpoint ref, and restore commands to `sys.stderr`. Returns exit code `1`.
  - `push_unverified`: Prints `[PUSH UNVERIFIED]` to `sys.stderr`. Returns exit code `1`.
- **Error Trapping**: Encloses invocations in a `try...except SyncGitError` block, preventing unhandled stack traces and returning structured JSON or clean stderr messages with exit code `1`.

---

## 3. Technical Analysis: Divergent Collision Detection & Plumbing

### 3.1 The Divergence Vulnerability
In a shared repository checkout, if remote branch tip `rem_sha` has advanced past local `head_sha`:
- A simple isolated sync would replay local files on top of `rem_sha`.
- However, if another agent concurrently committed modifications to the *same* owned path on the remote, replaying the local disk file on top of `rem_sha` without detection could silently overwrite the remote peer's changes upon push (or fail late at push time without semantic explanation).

### 3.2 Detection Architecture (`agent_branches/sync_git.py`, lines 611–680)
The implementation in `sync_isolated_owned_paths` executes collision detection *before* touching any Git index, tree, or commit creation:

```python
if rem_sha is not None and rem_sha != head_sha:
    mb_res = subprocess.run(["git", "merge-base", head_sha, rem_sha], ...)
    if mb_res.returncode == 0:
        merge_base = mb_res.stdout.strip()
        diff_tree_res = subprocess.run(
            ["git", "diff-tree", "-r", "--name-only", "--no-commit-id", merge_base, rem_sha], ...
        )
        if diff_tree_res.returncode == 0:
            remote_changed = set(diff_tree_res.stdout.splitlines())
            colliding = [p for p in normalized_owned if p in remote_changed]
            if colliding:
                conflicts = []
                for p in colliding:
                    disk_hash_res = subprocess.run(["git", "hash-object", p], ...)
                    rem_hash_res = subprocess.run(["git", "rev-parse", f"{rem_sha}:{p}"], ...)
                    if rem_hash_res.returncode == 0 and disk_hash_res.returncode == 0:
                        if disk_hash_res.stdout.strip() != rem_hash_res.stdout.strip():
                            conflicts.append(p)
                if conflicts:
                    return {
                        "status": "conflict",
                        "error": (...),
                        "conflicts": conflicts,
                        "merge_base": merge_base,
                        "remote_sha": rem_sha,
                        "shared_checkout_head": head_sha,
                        "shared_checkout_advanced": False,
                        "verified": False,
                        "in_sync": False,
                        "message": "Divergent owned-path collision detected. Refusing to overwrite remote changes. Working tree, index, and HEAD left untouched.",
                        "recovery_instructions": f"Inspect remote changes with `git diff {merge_base[:8]}..{rem_sha[:8]} -- {' '.join(conflicts)}`. Manually reconcile or merge before re-syncing.",
                    }
```

### 3.3 Verification of Fail-Closed Invariants
1. **Zero Mutation**: When a divergent collision is detected, execution halts before `tempfile.mkstemp`, `read-tree`, `write-tree`, or `commit-tree` are called. No commit objects are created, the shared `.git/index` is never accessed, and local `HEAD` remains unchanged.
2. **Accurate Blob Hashing**: Rather than assuming any change between `merge_base` and `rem_sha` is a collision, it verifies whether the disk file blob (`git hash-object p`) matches the remote blob (`git rev-parse rem_sha:p`). If both have converged to the identical content, it does not falsely report a conflict.
3. **Actionable Remediation**: Returns exact `merge_base`, `remote_sha`, and shell commands for the agent to inspect the diff (`git diff <base>..<rem> -- <paths>`).

---

## 4. Technical Analysis: Durable Checkpoint References

### 4.1 Danger of Dangling Unpushed Commits
Prior to commit `3da93b6`, when a refspec push failed (e.g., due to network timeout or non-fast-forward rejection), the function returned `status: "unpushed_checkpoint"` containing the `published_commit` SHA. While the Git object database held the commit object, no Git ref pointed to it. If the agent crashed or failed to record the SHA, the commit was subject to future `git prune` / `git gc` and could not be discovered via standard ref listing (`git branch`, `git tag`).

### 4.2 Durable Reference Implementation (`agent_branches/sync_git.py`, lines 779–839)
In both the push timeout handler and push rejection handler:
1. Generates a timestamped checkpoint ref:
   ```python
   timestamp_str = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
   safe_branch = target_branch.replace("/", "-")
   checkpoint_ref = f"refs/checkpoints/isolated-{safe_branch}-{timestamp_str}"
   ```
2. Writes the ref via Git plumbing:
   ```python
   subprocess.run(["git", "update-ref", checkpoint_ref, published_commit_sha], ...)
   ```
3. Formulates explicit, copy-pasteable restore instructions:
   ```python
   restore_instr = (
       f"Commit preserved at ref '{checkpoint_ref}' (SHA: {published_commit_sha}). "
       f"To inspect: `git show {checkpoint_ref}`. "
       f"To branch from checkpoint: `git checkout -b restore-{published_commit_sha[:8]} {checkpoint_ref}`."
   )
   ```
4. Returns `checkpoint_ref` and `restore_instructions` in the result dictionary and displays them prominently in stderr output.

This permanently roots the commit object graph in a visible, named ref under `refs/checkpoints/`, guaranteeing data survivability across restarts and clean recovery pathways.

---

## 5. Test Suite Execution & Negative Test Results

### 5.1 Full Test Suite Run
The complete test suite in `tests/test_sync_git.py` was executed directly against commit `3da93b6`:

```bash
cd /home/alexey/git/agent-branches && PYTHONPATH=. pytest -v tests/test_sync_git.py
```

### 5.2 Execution Output
```
============================= test session starts ==============================
platform linux -- Python 3.12.3, pytest-9.1.1, pluggy-1.6.0 -- /usr/bin/python3
cachedir: .pytest_cache
rootdir: /home/alexey/git/agent-branches
plugins: anyio-4.12.1, opik-2.2.54
collecting ... collected 23 items                                                             

tests/test_sync_git.py::TestSyncGit::test_clean_ahead_push_timeout_handling PASSED [  4%]
tests/test_sync_git.py::TestSyncGit::test_clean_ahead_pushes_to_remote PASSED [  8%]
tests/test_sync_git.py::TestSyncGit::test_cli_sync_git_isolated_mode PASSED [ 13%]
tests/test_sync_git.py::TestSyncGit::test_forbidden_file_ignored_during_sync PASSED [ 17%]
tests/test_sync_git.py::TestSyncGit::test_forbidden_patterns PASSED      [ 21%]
tests/test_sync_git.py::TestSyncGit::test_get_remote_sha_timeout_fail_closed PASSED [ 26%]
tests/test_sync_git.py::TestSyncGit::test_noop_when_clean_and_in_sync PASSED [ 30%]
tests/test_sync_git.py::TestSyncGit::test_porcelain_z_special_character_paths PASSED [ 34%]
tests/test_sync_git.py::TestSyncGit::test_pre_staged_new_forbidden_patterns_rejected PASSED [ 39%]
tests/test_sync_git.py::TestSyncGit::test_pre_staged_secret_rejected PASSED [ 43%]
tests/test_sync_git.py::TestSyncGit::test_preview_mode PASSED            [ 47%]
tests/test_sync_git.py::TestSyncGit::test_push_failure_preserves_local_checkpoint PASSED [ 52%]
tests/test_sync_git.py::TestSyncGit::test_push_timeout_handling_returns_unpushed_checkpoint PASSED [ 56%]
tests/test_sync_git.py::TestSyncGit::test_remote_mismatch_returns_push_unverified PASSED [ 60%]
tests/test_sync_git.py::TestSyncGit::test_repo_lock_concurrency PASSED   [ 65%]
tests/test_sync_git.py::TestSyncGit::test_sync_commit_and_push_verified PASSED [ 69%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_divergent_collision_fail_closed PASSED [ 73%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_missing_owned_path PASSED [ 78%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_noop PASSED [ 82%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_push_rejection_preserves_checkpoint PASSED [ 86%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_secret_forbidden PASSED [ 91%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_success_and_shared_checkout_untouched PASSED [ 95%]
tests/test_sync_git.py::TestSyncGit::test_whitelisted_env_example_can_be_synced PASSED [100%]

============================== 23 passed in 2.86s ==============================
```

**Status**: 23/23 tests passed cleanly (100% pass rate).

### 5.3 Detailed Negative Test Assertions
1. `test_sync_isolated_owned_paths_divergent_collision_fail_closed`:
   - Simulates concurrent remote modification to `owned.txt` in a remote clone.
   - Creates a conflicting local edit to `owned.txt` AND an uncommitted peer file `peer_dirty.txt`.
   - Confirms `res["status"] == "conflict"`, `res["conflicts"] == ["owned.txt"]`, `res["shared_checkout_advanced"] is False`.
   - Asserts local checkout `HEAD` is strictly unmodified (`current_head == initial_head`).
   - Asserts peer dirty file remains untracked and intact (`?? peer_dirty.txt`).
   - Asserts remote tip preserves remote concurrent edit (`remote concurrent edit v1`).
2. `test_sync_isolated_owned_paths_push_rejection_preserves_checkpoint`:
   - Verifies that upon simulated non-fast-forward push rejection, `checkpoint_ref` (`refs/checkpoints/isolated-...`) is created.
   - Confirms `git rev-parse <checkpoint_ref>` resolves exactly to `published_sha`.
   - Confirms `restore_instructions` are provided.
3. `test_cli_sync_git_isolated_mode`:
   - Validates invocation of `agent_branches.cli.main()` with `["sync", "git", "--repo-dir", ..., "--owned-path", "cli_owned.txt", "--json"]`.
   - Confirms clean exit code `0`, JSON parsing, `status: "synced"`, `verified: True`, and `shared_checkout_advanced: False`.

---

## 6. Shared Workspace Contention Verification

- Target repository edit scope: strictly `/home/alexey/git/agent-branches`.
- Verified `/home/alexey/git/cloudflare-agent-git` edit scope: **strictly zero edits**. No files in `cloudflare-agent-git` were staged, modified, or touched during this review.

---

## 7. Final Verdict

**VERDICT: ACCEPTED**

Commit `3da93b6` provides a complete, robust, and clean implementation:
- The CLI exposure enables ergonomic script and operator usage with explicit safety flags.
- Divergent collision detection strictly fails closed, preventing accidental clobbering of remote peer work.
- Durable checkpoint refs eliminate dangling Git objects during push network or concurrency failures.
- Unit tests comprehensively verify all isolation invariants and failure recovery paths.
