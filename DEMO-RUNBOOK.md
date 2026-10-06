# Demo Runbook: Agent Branches Sync Git

This runbook demonstrates the `branches sync git` functionality, showing how it safely checkpoints source code while rigorously protecting secrets and forbidden files.

## 1. Setup a Test Repository

First, create a dummy local repository to test the functionality:

```bash
mkdir -p /tmp/demo-sync-git && cd /tmp/demo-sync-git
git init -b main
git config user.name "Demo Agent"
git config user.email "agent@demo.local"

# Create a dummy remote
git init --bare /tmp/demo-sync-git-remote
git remote add origin /tmp/demo-sync-git-remote

# Initial commit
echo "# Demo Repo" > README.md
git add README.md
git commit -m "Initial commit"
git push origin main
```

## 2. Prepare Working Tree Changes

Create a mix of valid source files and forbidden secrets to demonstrate the filtering logic.

```bash
# Modified tracked file
echo "Updated content" >> README.md

# Safe untracked source file
echo "def hello(): pass" > app.py

# Forbidden secrets / local files
echo "SECRET_KEY=12345" > .env
echo "local data" > .local/state.db
echo "ssh-rsa AAA..." > id_rsa
```

## 3. Verify Preview Mode

Run the sync command in preview mode using the canonical `./branches` CLI to inspect what will be staged and what will be ignored:

```bash
# Execute via the canonical entrypoint in agent-branches repo
cd /home/alexey/git/agent-branches

# Run preview mode
./branches sync git --repo-dir /tmp/demo-sync-git --preview
```

**Expected Output:**
```
[PREVIEW] Branch: main
  To stage (2 files):
    modified: README.md
    untracked safe: app.py
  Ignored private/sensitive:
    ignored: .env
    ignored: .local/state.db
    ignored: id_rsa
```
Notice that `app.py` and `README.md` are correctly staged, while the secrets and local state files are safely ignored.

## 4. Execute Git Sync (Standard Repository Mode)

Perform the actual sync, which commits the safe changes and pushes them to the remote:

```bash
./branches sync git --repo-dir /tmp/demo-sync-git --message "feat: add app.py"
```

**Expected Output:**
```
[SYNCED] Checkpoint committed and pushed successfully.
  Branch: main
  Commit: <new-commit-hash>
  Remote SHA: <new-commit-hash> (verified: True)
  Files: 2 committed
```

## 5. Isolated Owned-Path Sync Mode (Zero Mutation to Peer Work)

When multiple agents or newcomers work in a shared checkout with uncommitted peer edits, use `--isolated` with `--owned-path` (repeatable or comma-separated).

This mode:
1. Creates an isolated temporary git index (`mkstemp`), leaving the shared `.git/index` and checkout `HEAD` 100% untouched.
2. Commits and pushes only the specified `--owned-path` files directly to the remote branch (`refs/heads/<branch>`).
3. Preserves all uncommitted peer dirty files in the shared working tree.
4. Detects divergent collisions fail-closed (`status: conflict`) without overwriting concurrent remote changes.

```bash
# Newcomer tests changes before syncing
./branches sync git --repo-dir /tmp/demo-sync-git --owned-path src/app.py --preview --json

# Execute isolated sync
./branches sync git --repo-dir /tmp/demo-sync-git --owned-path src/app.py -m "feat(core): implement feature" --json
```

**Expected Output:**
```json
{
  "status": "synced",
  "branch": "main",
  "published_commit": "<sha>",
  "remote_sha": "<sha>",
  "shared_checkout_head": "<unchanged-head>",
  "shared_checkout_advanced": false,
  "owned_paths": ["src/app.py"],
  "verified": true,
  "in_sync": true
}
```

## 6. Ordinary Git Remote Recovery

To recover or restore any checkpoint pushed via Agent Branches, standard Git tooling is all that is required—no specialized runtime or heavy dependencies:

```bash
# Clone the remote directly
git clone /tmp/demo-sync-git-remote /tmp/demo-recovered-repo

# Verify exact restoration of source files
cd /tmp/demo-recovered-repo
git log -n 5 --oneline
```

The recovered repository will contain all published source commits and owned paths, while sensitive files (`.env`, `id_rsa`) and uncommitted peer state remain completely excluded.

