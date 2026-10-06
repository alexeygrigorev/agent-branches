# Independent Code & Negative-Test Review: Isolated Owned-Path Sync Mode

- **Reviewer**: Independent Code & Negative-Test Auditor (Antigravity Subagent)
- **Reviewer Conversation ID**: `a2370471-a272-4a47-9cf3-937270a62863`
- **Date**: 2026-10-06
- **Audited Commit**: `2646dff0eda716cdf1237a2c9b61d8ead89bfb15` (`2646dff`)
- **Intake Reference**: [`research/INTAKE-ISOLATED-OWNED-PATH-SYNC-20261006.md`](file:///home/alexey/git/agent-branches/research/INTAKE-ISOLATED-OWNED-PATH-SYNC-20261006.md) (commit `0b2bdd6`, intake signal `BRANCHES-OWNED-PATH-REMOTE-SYNC-INTAKE-C2786-20261006`)
- **Target Repository**: `/home/alexey/git/agent-branches`
- **Audited Files**:
  - `agent_branches/sync_git.py` (`sync_isolated_owned_paths`)
  - `tests/test_sync_git.py` (5 new unit tests)
- **Final Verdict**: **ACCEPTED (WITH QUALIFICATIONS NOTED)**

---

## 1. Executive Summary & Traceability

Commit `2646dff` in `/home/alexey/git/agent-branches` implements the `sync_isolated_owned_paths` function and associated negative test coverage, fulfilling the feature intake recorded in `research/INTAKE-ISOLATED-OWNED-PATH-SYNC-20261006.md` (commit `0b2bdd6`).

### Originating Problem & Motivation
In high-concurrency multi-agent environments sharing a common workspace checkout:
1. Remote divergence occurs when remote `origin/main` advances due to pushes by other agents or systems.
2. Concurrent peer agents maintain dirty, uncommitted working tree files in the shared workspace.
3. Standard Git commands fail catastrophically:
   - `git pull` / `git merge` clobbers uncommitted peer files or aborts with dirty working tree errors.
   - `git stash` touches peer working tree files, risking data loss or merge conflicts on pop.
   - `git add .` stages unrelated peer work, violating single-writer attribution and leaking partial work.
   - `git reset` drops uncommitted changes across the entire workspace.
4. The Codex Principal was previously forced to use manual, ad-hoc index replay workarounds.

Commit `2646dff` elevates this workaround into a first-class, verified product feature: **isolated owned-path synchronization**.

---

## 2. Implementation Analysis: `sync_isolated_owned_paths`

The function `sync_isolated_owned_paths` in `agent_branches/sync_git.py` (lines 534–756) provides clean, robust isolation using low-level Git plumbing commands.

### 2.1 Pipeline Architecture
1. **Input Validation & Secret Guarding**:
   - Validates that `repo_dir` contains a valid `.git` directory.
   - Validates that `owned_paths` is non-empty.
   - Iterates through each path in `owned_paths`:
     - Checks against `is_forbidden(p_str)`, raising `SecretLeakageError` immediately if secrets (`.dev.vars`, private keys, credential stores, `.env*` except whitelisted templates) are targeted.
     - Verifies path safety against directory traversal outside `repo_path`.
     - Confirms that the owned path exists on disk (`if not full_p.exists(): raise SyncGitError(...)`).
     - Normalizes paths relative to repository root.
2. **Lock Serialization**:
   - Encloses execution within `repo_lock(str(repo_path))`, acquiring an exclusive flock to serialize Git operations and prevent file-level race conditions.
3. **Checkout Baseline Inspection**:
   - Queries current local shared checkout `HEAD` (`git rev-parse HEAD`), guarded by `SUBPROCESS_TIMEOUT_SEC`.
   - Queries latest remote branch tip (`get_remote_sha(..., remote, target_branch)`). If present, sets `base_parent_sha = rem_sha` and performs `git fetch` to ensure remote commit objects are present locally. If the remote branch does not exist, defaults `base_parent_sha = head_sha`.
4. **Temporary Index Isolation (`GIT_INDEX_FILE`)**:
   - Creates a unique temporary index file via `tempfile.mkstemp(prefix="git_idx_isolated_")`.
   - Ensures cleanup in a strict `try ... finally: temp_idx.unlink(missing_ok=True)` block.
   - Passes `GIT_INDEX_FILE=<temp_idx>` via subprocess environment to all Git plumbing invocations.
   - The shared `.git/index` is never read, locked, or mutated.
5. **Plumbing Staging & Tree Construction**:
   - `git read-tree <base_parent_sha>`: Populates the isolated temporary index with the tree of the base commit (the remote tip).
   - `git add -- <normalized_owned>`: Stages **only** the specified owned paths into the isolated index directly from the working directory. Peer dirty files on disk are completely ignored.
   - `git diff-index --cached --quiet <base_parent_sha>`: Compares the isolated index with the base tree. If identical, returns a structured `noop` receipt (`status: "noop"`, `in_sync: True`, `verified: True`).
   - `git write-tree`: Writes the tree object directly to the Git object database and obtains `tree_sha`.
6. **Commit & Push via Direct Refspec**:
   - `git commit-tree tree_sha -p base_parent_sha -m commit_msg`: Creates a new commit object parented to `base_parent_sha`.
   - `git push remote <published_commit_sha>:refs/heads/<target_branch>`: Pushes the commit directly to the remote branch using explicit refspec.
   - Local checkout `HEAD` and local branch refs remain untouched.
7. **Failure Resilience & Checkpoint Preservation**:
   - Catches `subprocess.TimeoutExpired` during push (`PUSH_TIMEOUT_SEC = 60s`).
   - Catches non-zero push exit codes (e.g. non-fast-forward push rejection).
   - In both cases, returns `status: "unpushed_checkpoint"` with `shared_checkout_advanced: False`, `verified: False`, and `in_sync: False`. Crucially, the created commit object remains safely preserved in the local Git object store.
8. **Verification**:
   - Queries `get_remote_sha` post-push to confirm that the remote tip matches `published_commit_sha`.

---

## 3. Negative Testing & Verification Results

### 3.1 Unit Test Suite Execution
The dedicated unit test suite in `tests/test_sync_git.py` was executed directly against commit `2646dff`:

```bash
cd /home/alexey/git/agent-branches && PYTHONPATH=. pytest -v tests/test_sync_git.py
```

**Result**: All 21 tests passed cleanly in 2.79s.

### 3.2 Detailed Audit of the 5 New Negative Tests
The 5 new unit tests in `tests/test_sync_git.py` specifically validate the isolation guarantees and negative failure modes:

| Test Name | Verified Invariant | Result |
| :--- | :--- | :--- |
| `test_sync_isolated_owned_paths_success_and_shared_checkout_untouched` | 1. Owned file pushed cleanly.<br>2. Local checkout `HEAD` strictly unmodified.<br>3. Peer dirty file (`peer_dirty.txt`) remains uncommitted (`?? peer_dirty.txt`).<br>4. Remote commit tree contains owned path but omits peer dirty file. | **PASSED** |
| `test_sync_isolated_owned_paths_noop` | Re-running sync with identical owned path contents returns `status: "noop"`, `in_sync: True`, `verified: True` without creating redundant commits. | **PASSED** |
| `test_sync_isolated_owned_paths_secret_forbidden` | Attempting to sync `.dev.vars` or any secret pattern raises `SecretLeakageError` immediately before any Git plumbing executes. | **PASSED** |
| `test_sync_isolated_owned_paths_missing_owned_path` | Supplying a non-existent file in `owned_paths` raises `SyncGitError("Owned path does not exist on disk: ...")`. | **PASSED** |
| `test_sync_isolated_owned_paths_push_rejection_preserves_checkpoint` | Non-fast-forward push rejection returns `status: "unpushed_checkpoint"`, leaves local `HEAD` untouched, and retains the commit object in Git object database (`git cat-file -t` confirms object existence). | **PASSED** |

---

## 4. Analysis of Isolation Guarantees

1. **Shared `.git/index` Protection**:
   - Full isolation is guaranteed via `GIT_INDEX_FILE` targeting a temporary file created via `tempfile.mkstemp`.
   - The shared `.git/index` file is neither read nor written during `sync_isolated_owned_paths`.
2. **Local Checkout `HEAD` Protection**:
   - The function never invokes `git checkout`, `git switch`, `git reset`, or `git merge`.
   - Commits are pushed via explicit refspec (`<commit_sha>:refs/heads/<branch>`), bypassing local reference updates.
   - Receipts explicitly report `shared_checkout_advanced: False` and preserve `shared_checkout_head`.
3. **Working Tree Protection**:
   - `git add -- <normalized_owned>` operates only on the enumerated paths.
   - Dirty, modified, untracked, or conflicted peer files on disk are completely untouched and excluded from staging and tree generation.

---

## 5. Technical Limitations & Qualifications

The following architectural limitations were noted during the audit and should be factored into operational usage:

1. **Path Deletion Limitation**:
   `sync_isolated_owned_paths` verifies `if not full_p.exists(): raise SyncGitError(...)`. Consequently, deleting an owned path on disk cannot currently be recorded via this function; it is designed for adding and updating modified paths. Deletion synchronization requires future enhancement (e.g. `git rm --cached`).
2. **Network & SSH Transport Timeouts**:
   `PUSH_TIMEOUT_SEC` is capped at 60.0s, and `SUBPROCESS_TIMEOUT_SEC` is 30.0s. If an SSH or HTTPS remote endpoint is unresponsive, the operation returns `unpushed_checkpoint`. The commit is preserved locally in the Git object database, but remote synchronization will require retrying when network connectivity recovers.
3. **SSH Key / Host Authentication**:
   Network operations rely on the environment's Git/SSH configuration. Host key rejections or missing SSH keys will result in push failure, cleanly returning `unpushed_checkpoint` without data loss.
4. **Concurrent Owned-Path Collisions**:
   If remote `HEAD` has advanced with changes touching the *exact same* owned paths, the refspec push will be rejected as non-fast-forward (`unpushed_checkpoint`). In such cases, semantic three-way merging of the owned paths is required prior to push.

---

## 6. Audit Verdict & Sign-Off

**VERDICT: ACCEPTED (WITH QUALIFICATIONS NOTED)**

Commit `2646dff` in `/home/alexey/git/agent-branches` delivers an isolated, secure, and rigorously tested owned-path synchronization capability that fulfills all requirements of intake `0b2bdd6`. It guarantees zero mutation of shared `.git/index`, local `HEAD`, or peer dirty working tree files, enforces fail-closed secret protection, and reliably preserves unpushed checkpoints upon network or remote conflict failure.
