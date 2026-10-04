#!/usr/bin/env bash
# Push canonical main to origin without force. Refuse dirty private files,
# conflicting history, and rewrites. Logs source SHA and remote SHA.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/.local/raw"
mkdir -p "$LOG_DIR"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG="$LOG_DIR/sync-main-$STAMP.log"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"
}

fail() {
  log "ERROR: $*"
  exit 1
}

SOURCE_SHA=""
if [[ -f docs/SOURCE-PROVENANCE.md ]]; then
  SOURCE_SHA="$(sed -n 's/^- Source commit: `\([^`]*\)`/\1/p' docs/SOURCE-PROVENANCE.md | head -1)"
fi

log "sync-main start"
log "sourceSHA=${SOURCE_SHA:-unknown}"
log "pwd=$ROOT"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not a git worktree"

branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || fail "refusing to sync branch '$branch' (pinned main only)"

# Private / extracted-local paths must never be staged or committed.
private_globs=(
  '.local'
  '.env'
  '.env.*'
  'node_modules'
  '__pycache__'
  '*.log'
  'live/.dev.vars'
  'prototype/.dev.vars'
  'prototype/local-coordinator-state.json'
  'live/evidence'
  'live/state'
  'live/work'
  'live/artifacts'
)

dirty="$(git status --porcelain)"
if [[ -n "$dirty" ]]; then
  while IFS= read -r line; do
    path="${line:3}"
    path="${path##* -> }"
    for glob in "${private_globs[@]}"; do
      case "$path" in
        $glob|$glob/*)
          fail "refusing sync; private or excluded path is dirty: $path"
          ;;
      esac
    done
  done <<< "$dirty"
  fail "refusing sync; working tree is dirty. Commit intended product files first."
fi

# Skip private files if they somehow got staged (defense in depth).
staged="$(git diff --cached --name-only || true)"
if [[ -n "$staged" ]]; then
  fail "refusing sync; index is not empty: $staged"
fi

tracked_private="$(git ls-files .local .env 'live/.dev.vars' 'prototype/.dev.vars' 'prototype/local-coordinator-state.json' 'live/evidence' 'node_modules' || true)"
if [[ -n "$tracked_private" ]]; then
  fail "refusing sync; private files are tracked: $tracked_private"
fi

local_sha="$(git rev-parse HEAD)"
local_tree="$(git rev-parse 'HEAD^{tree}')"
log "localSHA=$local_sha"
log "localTree=$local_tree"

git remote get-url origin >/dev/null 2>&1 || fail "origin remote is missing"

origin_url="$(git remote get-url origin)"
case "$origin_url" in
  git@github.com:alexeygrigorev/agent-branches.git|https://github.com/alexeygrigorev/agent-branches.git)
    ;;
  *)
    fail "origin is not alexeygrigorev/agent-branches: $origin_url"
    ;;
esac

git fetch origin main --quiet || log "fetch origin main: branch may be absent on first push"

if git rev-parse --verify origin/main >/dev/null 2>&1; then
  remote_sha="$(git rev-parse origin/main)"
  remote_tree="$(git rev-parse 'origin/main^{tree}')"
  log "remoteSHA=$remote_sha"
  log "remoteTree=$remote_tree"
  if [[ "$remote_sha" == "$local_sha" ]]; then
    log "already up to date"
    echo "sourceSHA=$SOURCE_SHA"
    echo "localSHA=$local_sha"
    echo "remoteSHA=$remote_sha"
    exit 0
  fi
  if git merge-base --is-ancestor origin/main HEAD; then
    log "fast-forward possible: origin/main ($remote_sha) -> HEAD ($local_sha)"
  else
    fail "refusing non-fast-forward sync. local=$local_sha remote=$remote_sha source=$SOURCE_SHA"
  fi
else
  log "origin/main absent; first push of pinned main"
fi

# Never --force. Never --force-with-lease.
git push origin main
git fetch origin main --quiet
remote_sha="$(git rev-parse origin/main)"
remote_tree="$(git rev-parse 'origin/main^{tree}')"
log "pushed"
log "sourceSHA=${SOURCE_SHA:-unknown}"
log "localSHA=$local_sha"
log "remoteSHA=$remote_sha"
log "remoteTree=$remote_tree"

if [[ "$remote_sha" != "$local_sha" ]]; then
  fail "post-push SHA mismatch local=$local_sha remote=$remote_sha"
fi

echo "sourceSHA=$SOURCE_SHA"
echo "localSHA=$local_sha"
echo "remoteSHA=$remote_sha"
echo "remoteTree=$remote_tree"
echo "log=$LOG"
