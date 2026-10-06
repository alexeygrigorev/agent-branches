# Adversarial Code & Security Review: `agent-branches sync git`

- **Reviewer**: Distinct Independent Code & Security Reviewer (Antigravity)
- **Date**: 2026-10-06
- **Pinned Commit Reviewed**: `633f27ae14339a104d21823bbbe80d931166cfba` (`633f27a`)
- **Target Repository**: `/home/alexey/git/agent-branches`
- **Reviewed Components**:
  - `agent_branches/sync_git.py` (implementation, lines 1–400)
  - `agent_branches/cli.py` (CLI subcommand `sync git`, lines 384–392, 681–735)
  - `tests/test_sync_git.py` (11 unit tests, lines 1–209)
  - `research/REPORT-BRANCHES-SYNC-GIT-DOGFOODING-20261006.md` (dogfooding report)
  - Recent commits: `633f27a`, `ccc021a`, `1fa3ab9`
- **Formal Verdict**: **CHANGES_REQUESTED**

---

## 1. Executive Summary & Review Scope

An exhaustive, adversarial code and security review was conducted on the one-command Git synchronization mechanism `agent-branches sync git`. The tool is intended to provide autonomous agent sessions with an automated, sanitized Git checkpoint and synchronization workflow that guarantees:
1. Strict secret and private file protection.
2. Pre-staged index sanitization (fail-closed).
3. Local checkpoint commit preservation on push failure (never resets or drops unpushed commits).
4. Clean-ahead push and remote SHA verification.
5. Mutual exclusion and process serialization via `.local/git.lock`.

The audit evaluated both defensive implementation details and active adversarial exploit vectors, including path traversal, delimiter injection, race conditions, timeout handling, subshell execution, and pattern circumvention.

While the core architecture for checkpoint preservation, clean-ahead recovery, and remote SHA verification is well-designed and functional (11/11 unit tests pass), the review discovered **two high-severity secret leakage vectors**, **two medium-severity robustness defects**, and **gaps in unit test concurrency coverage**. Consequently, the formal verdict is **CHANGES_REQUESTED**.

---

## 2. Review Methodology

1. **Static Analysis & Pattern Auditing**:
   - Analyzed `FORBIDDEN_PATTERNS`, `SAFE_SOURCE_EXTENSIONS`, and `is_forbidden()` in `agent_branches/sync_git.py`.
   - Audited index inspection logic (`git diff --cached --name-only -z`) and working tree porcelain parsing (`git status --porcelain=v1 -z -uall`).
   - Audited process locking mechanics (`fcntl.flock`) and file descriptor lifecycle.
   - Evaluated exception handling across `sync_git.py` and `cli.py`.

2. **Dynamic Adversarial Testing**:
   - Executed live penetration tests against temporary repositories using realistic secret patterns, non-standard SSH keys, and Cloudflare Wrangler environment files.
   - Tested boundary conditions: filenames with newlines (`\n`), spaces, and leading dashes (`--help.py`).
   - Tested network simulation: remote repository divergence (non-fast-forward push), network timeouts, and detached `HEAD`.
   - Tested concurrency contention: multi-threaded flock contention and timeout expiration.

---

## 3. Security Audit Findings

### [VULN-SEC-01] (HIGH) Cloudflare Wrangler Secret File `.dev.vars` Bypasses Forbidden Filter

- **Location**: `agent_branches/sync_git.py`, lines 25–37 (`FORBIDDEN_PATTERNS`)
- **Description**: In Cloudflare Workers development (the core ecosystem for `agent-branches`), local development secrets, API keys, and environment variables are standardly stored in `.dev.vars` and `.dev.vars.*` (as recognized in `.gitignore` lines 10 & 15). However, `.dev.vars` is **omitted** from `FORBIDDEN_PATTERNS`.
- **Adversarial Test**:
  ```python
  from agent_branches.sync_git import is_forbidden
  assert is_forbidden(".dev.vars") is True  # FAILS: returns False!
  assert is_forbidden("live/.dev.vars") is True  # FAILS: returns False!
  ```
- **Impact**: If an agent creates `.dev.vars` in any repository directory not matched by `.gitignore`, or stages `.dev.vars`, `is_forbidden()` evaluates to `False`. The pre-staged secret scan fails to trigger, and `sync_git` stages, commits, and pushes plaintext Cloudflare secrets to public GitHub.
- **Remediation**: Add `.dev.vars` and `.dev.vars.*` to `FORBIDDEN_PATTERNS`.

---

### [VULN-SEC-02] (HIGH) Common Secret Filenames (`secrets.json`, `api_key.json`, `auth_token.txt`) Bypass Pattern Matching

- **Location**: `agent_branches/sync_git.py`, lines 58–73 (`is_forbidden`)
- **Description**: `is_forbidden(rel_path)` implements strict prefix and suffix checks on `Path(p_str).name`:
  ```python
  if pat.startswith("."):
      if name == pat or name.startswith(pat + ".") or name.endswith(pat):
          return True
  else:
      if name == pat or name.startswith(pat + ".") or name.endswith("." + pat):
          return True
  ```
  Because the check requires `name.startswith(pat + ".")` (e.g. `token.json` or `credentials.yaml`), any file where the secret identifier appears as a suffix, infix, or alternate naming pattern evaluates to `False`:
  - `api_key.json` (does not start with `.key.`) -> `is_forbidden == False`
  - `auth_token.txt` (does not start with `token.`) -> `is_forbidden == False`
  - `secrets.json` / `secret.json` (`secret` is not in `FORBIDDEN_PATTERNS`) -> `is_forbidden == False`
  - `service_account.json` / `client_secret.json` -> `is_forbidden == False`
  - `openai_key.json` -> `is_forbidden == False`
- **Adversarial Test**:
  Since `.json` and `.txt` are included in `SAFE_SOURCE_EXTENSIONS` (line 40), untracked files with these names are placed into `untracked_safe_to_add` in `get_status_entries()`, staged via `git add`, and pushed to remote without warning.
- **Impact**: Automatic leakage of API credentials and keys named in standard enterprise/cloud formats.
- **Remediation**:
  1. Add `"secret"`, `"secrets"`, `"service_account"`, `"service-account"`, and `"api_key"` to `FORBIDDEN_PATTERNS`.
  2. Enhance `is_forbidden` matching logic to catch infix secret tokens (e.g. `*_token.*`, `*_key.*`, `*_secret.*`).

---

### [VULN-SEC-03] (MEDIUM) Missing Non-RSA SSH Keys and Package Credential Stores

- **Location**: `agent_branches/sync_git.py`, lines 27–28
- **Description**: Only `id_rsa` and `id_ed25519` are blacklisted. Modern OpenSSH algorithms and identity files are missing:
  - `id_ecdsa`, `id_dsa`, `id_ecdsa_sk`, `id_ed25519_sk`
  - Package manager and network credential stores: `.netrc`, `.npmrc`, `.pypirc`
- **Adversarial Test**:
  `is_forbidden("id_ecdsa")` returns `False`. If previously added or explicitly staged, the pre-scan fails-open.
- **Impact**: Potential leakage of SSH private keys and package registry auth tokens.
- **Remediation**: Add `id_*` wildcard or explicit patterns `id_ecdsa`, `id_dsa`, `id_ecdsa_sk`, `id_ed25519_sk`, and `.netrc`, `.npmrc`, `.pypirc`.

---

### [VULN-SEC-04] (MEDIUM) Directory-Level Secret Paths Ignored When Pattern Lacks Trailing Slash

- **Location**: `agent_branches/sync_git.py`, lines 61–72
- **Description**: If a pattern does not end with `/` (e.g. `credentials`, `token`), `is_forbidden` only checks `Path(p_str).name`, completely ignoring intermediate directories:
  - `is_forbidden(".credentials/config")` -> `False`
  - `is_forbidden(".secrets/config.json")` -> `False`
  - `is_forbidden(".ssh/authorized_keys")` -> `False`
  - `is_forbidden(".wrangler/config.json")` -> `False`
- **Remediation**: Ensure directory patterns like `.secrets/`, `.credentials/`, `.ssh/`, `.aws/`, `.wrangler/` are explicitly added to `FORBIDDEN_PATTERNS`.

---

### [OBS-SEC-05] (LOW) False Positive on Documentation Templates (`.env.example`)

- **Location**: `agent_branches/sync_git.py`, line 68
- **Description**: `.gitignore` explicitly allows `!.env.example`. However, `is_forbidden(".env.example")` evaluates to `True` because `name.startswith(".env.")`.
- **Impact**: Developers and agents cannot sync documentation templates like `.env.example` or `.env.template` using `sync git`. If pre-staged, it triggers `SecretLeakageError`.
- **Remediation**: Explicitly allow `.env.example`, `.env.template`, and `.env.sample`.

---

## 4. Functional & Concurrency Audit Findings

### 4.1 Git State & Data Integrity

- **Commit Preservation on Push Failure**: **VERIFIED (PASS)**
  - When `git push` fails (e.g., remote offline, network error, authentication failure), lines 355–370 preserve the commit on `HEAD`.
  - Audited against `git log` in live testing: no `git reset` or `git checkout` is performed.
  - Return structure correctly outputs status `unpushed_checkpoint` and returns exit code 1 to CLI.
- **Clean-Ahead Recovery**: **VERIFIED (PASS)**
  - When the working tree is clean and `head_sha != rem_sha`, Step 4 detects that local commits are ahead.
  - Executes `git push remote branch` and validates `rem_sha_after == head_sha`.
  - Tested in dogfooding and adversarial runs: recovery is clean and idempotent.
- **Remote SHA Verification**: **VERIFIED (PASS)**
  - Uses `git ls-remote remote refs/heads/{branch}` post-push.
  - Returns `push_unverified` (exit code 1) if the remote ref does not match local `HEAD`.
- **Upstream Divergence Handling**: **VERIFIED (PASS)**
  - Push command does not specify `--force`.
  - When remote contains conflicting/diverged commits, git rejects the push (`non-fast-forward / fetch first`).
  - `sync_git` preserves local HEAD without overwriting upstream, and returns `unpushed_checkpoint` with the exact upstream error.

---

### 4.2 Concurrency & Process Isolation

- **Mutual Exclusion (`repo_lock`)**: **VERIFIED (PASS)**
  - Implements non-blocking `fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)` in a polling loop on `.local/git.lock`.
  - Correctly times out after `timeout_sec` (default 10.0s) and raises `SyncGitError`.
  - File descriptor and flock are safely cleaned up via `try...finally`.
- **[LIMITATION-CONC-01] (MEDIUM) Worktree Lock Directory Isolation**:
  - `lock_dir = Path(repo_dir) / ".local"`.
  - In a Git worktree, `repo_dir` points to the linked worktree path rather than the common Git repository root (`git rev-parse --git-common-dir`).
  - Consequently, concurrent sync operations running in two separate worktrees of the same repository create independent locks in their respective `.local/git.lock` files, allowing simultaneous pushes to the same remote.
  - **Remediation**: Anchor the lock file to `subprocess.check_output(["git", "rev-parse", "--git-path", "git.lock"], cwd=repo_dir)` or `git rev-parse --git-common-dir` so all worktrees share the same lock.

---

## 5. Adversarial Test & Edge-Case Evaluation

| Scenario | Expected Behavior | Actual Behavior | Result |
| :--- | :--- | :--- | :--- |
| **Spaces in Filename** (`test file.py`) | Handled cleanly in status & stage | Handled cleanly via `-z` | **PASS** |
| **Newlines in Filename** (`file\nwith\nnewlines.py`) | Handled cleanly without splitting | Handled cleanly via `-z` split on `\0` | **PASS** |
| **Dash Prefix in Filename** (`--help.py`) | Staged without flag injection | `git add --` prevents flag injection | **PASS** |
| **Detached HEAD State** | Abort with named branch requirement | Raises `SyncGitError("Cannot sync detached HEAD...")` | **PASS** |
| **Pre-Staged Secret Detected** | Abort immediately fail-closed | Raises `SecretLeakageError` before staging | **PASS** |
| **Subprocess Timeout on Push** | Structured error return or handled exception | **Unhandled `subprocess.TimeoutExpired` crash** | **FAIL** |
| **Cloudflare `.dev.vars` Untracked** | Filtered into `ignored_forbidden` | **Staged and committed as safe file** | **FAIL** |
| **`secrets.json` Untracked** | Filtered into `ignored_forbidden` | **Staged and committed as safe file** | **FAIL** |
| **True Flock Contention Test** | Unit test verifies second process blocked | **Existing test only checks file existence** | **FAIL** |

### [DEFECT-EDGE-01] (MEDIUM) Subprocess Timeouts Raise Unhandled `subprocess.TimeoutExpired`

- **Location**: `agent_branches/sync_git.py`, lines 280, 347; `agent_branches/cli.py`, line 689
- **Description**: `subprocess.run(..., timeout=PUSH_TIMEOUT_SEC)` raises standard library `subprocess.TimeoutExpired` when a push or remote check hangs. Because `subprocess.TimeoutExpired` does not inherit from `SyncGitError`, it is not caught by `handle_sync_git` or `sync_git`.
- **Impact**: The CLI crashes with an unhandled Python traceback. When run with `--json`, it fails to emit valid JSON to stdout/stderr and exits with an unformatted crash.
- **Remediation**: Wrap `subprocess.run` in `try...except subprocess.TimeoutExpired as exc:` and return a structured `unpushed_checkpoint` dict (on push timeout) or raise `SyncGitError(f"Git command timed out: {exc}")`.

---

## 6. Test Suite Coverage & Rigor Audit

The existing test suite (`tests/test_sync_git.py`) contains 11 tests. While all 11 pass, the following gaps were identified:
1. `test_repo_lock_concurrency` (lines 201–205): Only tests `self.assertTrue(lock_path.exists())` inside a single thread! It does not test actual lock contention, mutual exclusion between threads/processes, or timeout handling.
2. Missing unit tests for:
   - Detached `HEAD` failure path.
   - Upstream divergence / non-fast-forward push rejection.
   - Subprocess timeout handling.
   - Comprehensive forbidden patterns (`.dev.vars`, `id_ecdsa`, etc.).

---

## 7. Required Action Items

Prior to production acceptance, the following fixes are required:

1. **Harden `FORBIDDEN_PATTERNS` and `is_forbidden()`**:
   - Add `.dev.vars`, `.dev.vars.*`, `.dev.vars.local`
   - Add `secrets.json`, `secret.json`, `*.secret.*`, `*_secret.*`
   - Add `api_key.*`, `*_key.*`, `auth_token.*`, `*_token.*`
   - Add `service_account.json`, `service-account.json`, `client_secret.json`
   - Add `.netrc`, `.npmrc`, `.pypirc`
   - Add non-RSA SSH key formats: `id_ecdsa`, `id_dsa`, `id_*_sk`
   - Add sensitive directory prefixes: `.secrets/`, `.credentials/`, `.ssh/`, `.aws/`, `.wrangler/`
   - Add exception whitelist for `.env.example`, `.env.template`, `.env.sample`.
2. **Handle `subprocess.TimeoutExpired` Gracefully**:
   - Catch `subprocess.TimeoutExpired` during push and ls-remote calls.
   - Return structured `unpushed_checkpoint` with `error: "Push timed out after 60s"`.
3. **Enhance Unit Test Suite**:
   - Upgrade `test_repo_lock_concurrency` to spawn a secondary thread/process asserting `SyncGitError` on contention.
   - Add test cases for detached `HEAD`, diverged remote push rejection, and new secret pattern matching.

---

## 8. Formal Verdict

**VERDICT: CHANGES_REQUESTED**

The core Git integrity mechanisms (checkpoint preservation, clean-ahead push, remote SHA verification, porcelain -z parsing) are fundamentally sound and verified. However, because `.dev.vars` (Cloudflare's primary secret store) and standard secret filenames (`secrets.json`, `api_key.json`) can be committed and pushed to public remotes under current rules, code modifications are required before production sign-off.
