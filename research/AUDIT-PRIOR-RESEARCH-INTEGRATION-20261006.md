# Audit of Prior Research Integration: `sync_git.py` and Sessionless Worker Bus

- **Date**: 2026-10-06
- **Target Repository**: `/home/alexey/git/agent-branches`
- **Reference Research Repository**: `/home/alexey/git/cloudflare-agent-git/research/`

## 1. Executive Summary

This report audits the current integration of prior research recommendations—specifically examining the `agent_branches/sync_git.py` implementation and the Sessionless Worker Bus adoption—against the strict operational requirements laid out in recent independent peer and adversarial reviews (`REV-BRANCHES-SYNC-GIT-20261006`, `REV-AGENTBUS-SESSIONLESS-WORKER-20261005`, and related receipts).

Both implementations successfully realize the core autonomous operational directives, adopting recommended defensive design patterns and recovering from adversarial test defects. However, minor technical gaps regarding lock-file worktree isolation and full production entrypoint binding remain.

---

## 2. `sync_git.py` Implementation Audit

### 2.1 Adopted Patterns
- **Safe Checkpoint Preservation**: On a `git push` failure (e.g., diverged remote, network timeout), the implementation preserves the local commit on `HEAD` and returns a structured `unpushed_checkpoint` status, ensuring agent work is never lost.
- **Fail-Closed Pre-Staged Secret Scan**: Uses `git diff --cached --name-only -z` to guarantee that manually or previously pre-staged forbidden files cause an immediate `SecretLeakageError` abort before any commit takes place.
- **Comprehensive Secret Blacklisting**: Fully integrated the remediations from the adversarial review. `FORBIDDEN_PATTERNS` now correctly blocks Cloudflare's `.dev.vars`, common secret filenames (`secrets.json`, `api_key.json`), non-RSA SSH keys (`id_ecdsa`), and sensitive directory structures (`.secrets/`, `.ssh/`), while actively whitelisting documentation templates (`.env.example`).
- **Clean-Ahead Recovery & Verification**: Gracefully handles situations where the local tree is clean but ahead of the remote, executes non-force pushes, and performs remote SHA equality verification (`ls-remote`).
- **NUL-Delimited Parsing**: Adopts strict porcelain `v1 -z -uall` parsing to robustly handle paths with spaces, unicode characters, and renames.
- **Robust Exception Handling**: Remediated the unhandled `subprocess.TimeoutExpired` crashes, converting push timeouts into structured `unpushed_checkpoint` JSON outputs.
- **Thread Contention Testing**: Enhanced `test_repo_lock_concurrency` to spawn a concurrent thread and positively assert `SyncGitError` upon actual file lock contention.

### 2.2 Rejected Designs
- **Dangerous Checkpoint Rollbacks**: Explicitly rejected the use of `git reset HEAD~1` on push failures, which historically risked destroying autonomous checkpoint data or racing concurrent users.
- **Interactive Commit Workflows**: Rejected all manual Git prompt resolutions in favor of purely automated, fail-closed programmatic aborts.
- **Uncoordinated Git Mutators**: Rejected naked Git command invocations, enforcing serialization via `fcntl.flock`.

### 2.3 Remaining Technical Gaps
- **Worktree Lock Directory Isolation (`[LIMITATION-CONC-01]`)**: The serialization lock file is hardcoded to `Path(repo_dir) / ".local" / "git.lock"`. For repositories utilizing Git worktrees, `repo_dir` points to the specific worktree path rather than the shared Git repository root. Consequently, concurrent agents operating in different worktrees of the same repository will not share the lock, risking index corruption on simultaneous pushes. Remediation requires anchoring the lock to `git rev-parse --git-common-dir` or `git rev-parse --git-path git.lock`.

---

## 3. Sessionless Worker Bus Implementation Audit

### 3.1 Adopted Patterns
- **Zero Interactive Session Leakage**: The headless worker logic successfully uses `SessionlessWorkerBus.register()`, explicitly setting `session_id=None` (which renders as `-` in the namespaced identifier). It inherently rejects reliance upon or forgery of the interactive Aplexer UUIDs.
- **Explicit Two-Phase ACK & Schema Validation**: Messaging tracks precise transport states (`SendReceipt`, `ReadAck`) and validates all payload envelopes strictly against the pinned public specification (`12f9bde`).
- **Durable Cursor Persistence (Exactly-Once Delivery)**: Cursors persist atomically to disk. Recovering workers query their cursor upon startup to prevent consuming previously acknowledged messages.
- **Credential Storage Security**: Access tokens and worker bus identities are persisted with strictly bounded `0600` (`-rw-------`) file permissions.

### 3.2 Rejected Designs
- **In-Process-Only Protocol Assertions**: The initial adoption receipt only verified in-process memory recreation of the worker instance (`del executor` -> `from_credentials()`). This methodology was firmly rejected in `REV-SESSIONLESS-HEADLESS-AGENTBUS-ADOPTION-20261006.md` for failing to empirically prove resilience against OS-level process deaths.

### 3.3 Remaining Technical Gaps
- **Production Orchestration Binding**: While the multi-process coding agent adoption harness (`scratch/run_multiprocess_coding_agent_bus_adoption.py`) perfectly proved OS-process-boundary survival, real autonomous task execution, and durable cursor persistence (PID_1 -> PID_2 restart), the `SessionlessWorkerBus` workflow has not yet been bound to a live, production-facing CLI daemon or entrypoint in the `agent-branches` codebase. The integration is currently limited to robust testing and verification harnesses.
