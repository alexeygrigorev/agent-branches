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

Run the sync command in preview mode to inspect what will be staged and what will be ignored:

```bash
# Return to the project directory to execute the module
cd /home/alexey/git/agent-branches/.local/scale50/wt-branches-sync

# Run preview mode
python3 -m agent_branches sync git --repo-dir /tmp/demo-sync-git --preview
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
Notice that `app.py` and `README.md` are correctly staged, while the secrets are safely ignored.

## 4. Execute Git Sync

Perform the actual sync, which commits the safe changes and pushes them to the remote:

```bash
python3 -m agent_branches sync git --repo-dir /tmp/demo-sync-git --message "feat: add app.py"
```

**Expected Output:**
```
[SYNCED] Checkpoint committed and pushed successfully.
  Branch: main
  Commit: <new-commit-hash>
  Remote SHA: <new-commit-hash> (verified: True)
  Files: 2 committed
```

## 5. Verify Secrets Were Not Pushed

Check the git commit to guarantee that no secrets leaked:

```bash
cd /tmp/demo-sync-git
git log -n 1 --name-only
```

You should see only `README.md` and `app.py` listed. The `.env` and `id_rsa` files will remain safely in the untracked working tree.
