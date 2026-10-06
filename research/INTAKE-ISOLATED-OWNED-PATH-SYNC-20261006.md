# Product Feature Intake: Isolated Owned-Path Checkpoint/Sync Mode

- **Intake Date**: 2026-10-06
- **Originating Signal**: Codex Principal & User Guidance (Message C2786)
- **Target Repository**: `/home/alexey/git/agent-branches`
- **Component**: `agent_branches/sync_git.py` / CLI `agent-branches sync git --isolated`

---

## 1. Context & User Problem

### Direct Human Quote & Principle
> *"repeated workarounds should be product features"*

### Empirical Failure Mode
In high-concurrency multi-agent development environments sharing a common workspace checkout:
1. **Legitimate Remote Divergence**: An external peer or orchestrator pushes legitimate commits to the remote repository (e.g. GitHub `origin/main`), advancing remote `HEAD`.
2. **Local Working Tree Dirty Paths**: At the same time, peer agents have uncommitted, dirty working files in the local shared checkout.
3. **Push Rejection**: When an agent attempts an ordinary `git push`, Git rejects it as non-fast-forward (`[rejected - non-fast-forward]`).
4. **Catastrophic Failure Modes of Standard Git Workarounds**:
   - `git pull` or `git merge` fails or risks dirty file clobbering / merge conflicts across unrelated peer files.
   - `git stash` touches or modifies peer uncommitted files across the entire tree, risking data loss.
   - `git add .` or broad staging stages unrelated peer work into a shared commit, destroying single-writer attribution and leaking unverified drafts.
   - `git reset` rolls back working tree edits or drops peer checkpoints.
5. **Real Workaround Used by Codex Principal**:
   The Codex Principal was forced to manually perform three isolated private index replay checkpoints (`2757536` -> `d7e859c`; `24483a6`; `048d2548`) using custom Git index manipulations.

---

## 2. Product Specification: `sync_isolated_owned_paths`

The `agent-branches` product must provide a native, isolated synchronization capability:

### Key Functional Requirements
1. **Explicit Owned-Path Scope**:
   Accepts an explicit list of owned paths (`owned_paths: List[str]`). Only these paths are included in the synchronization checkpoint.
2. **Zero Shared Index / Working Tree Mutation**:
   Uses an isolated temporary index file (`GIT_INDEX_FILE` in a private temporary directory). The shared repository index (`.git/index`), the shared checkout `HEAD`, and peer dirty files in the working tree are **NEVER** modified.
3. **Remote-Based Replay**:
   Reads the latest remote branch tip (`refs/remotes/{remote}/{branch}` or via `git ls-remote`), stages only the owned paths into the private index against the remote tree, and generates a commit object via `git commit-tree` parented to the remote tip.
4. **Direct Refspec Push & Verification**:
   Pushes the private commit directly to the remote branch using `<commit_sha>:refs/heads/<branch>`. Confirms remote SHA equality via `git ls-remote`.
5. **Fail-Closed Secret & Path Protection**:
   Strictly validates all candidate paths against `FORBIDDEN_PATTERNS`, `INFIX_SECRET_TOKENS`, and `SENSITIVE_DIRS`. Aborts immediately if forbidden files are targeted.
6. **Honest Divergence Semantics**:
   The return receipt explicitly distinguishes published commit state from checkout state:
   - `published_commit`: SHA of the commit created and pushed to the remote.
   - `shared_checkout_head`: SHA of the local shared checkout (unmodified).
   - `shared_checkout_advanced: False`: Honestly denotes that the local checkout has not been advanced.
7. **Conflict & Non-Fast-Forward Handling**:
   If the remote has concurrent changes touching the exact specified owned paths, the operation fails closed without altering history, returning an `unpushed_checkpoint` status.
8. **First Actual Internal User**:
   Principal metadata paths (`coordination/codex.md`, `research/codex/**`).
9. **Fallback**:
   Existing plain Git replay.
