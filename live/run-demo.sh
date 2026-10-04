#!/usr/bin/env bash
# Agent Branches — real end-to-end demo run (run 3, zc-live-5).
#
# Flow per prototype/CONTRACT.md v0.1.2 (L1 @ 3e9983b):
#   sidecar (L1 local-artifacts) + wrangler dev -> POST /setup -> canonical seed
#   push (per-repo write token) -> POST /tasks x3 (intent + base_sha per task) ->
#   agent pushes (reference patches) -> radar matrix -> POST /checks with the
#   radar's typed contract-"0.1" payload VERBATIM (no down-conversion) ->
#   stale 409 probe -> radar pass 2 -> UI screenshots (index + a task page) ->
#   assertions.
#
# Idempotency: data steps leave a marker under live/state/ and are skipped on
# re-runs; services are health-checked and started only when down.
# Server processes (gap G1): each one starts via setsid in its OWN process
# group; the pid recorded in live/state/ is the group leader. Cleanup kills
# the recorded GROUP (-PGID) only after verifying the cmdline matches the
# expected server AND the group is not this script's own — so killing
# wrangler also reaps its workerd child and no orphan keeps the port.
# Never kill by pattern.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIVE="$ROOT/live"
RUN_TAG="run-3"
STATE="$LIVE/state"; EVIDENCE="$LIVE/evidence/$RUN_TAG"; WORK="$LIVE/work"; ART="$LIVE/artifacts"
mkdir -p "$STATE" "$EVIDENCE" "$WORK" "$ART"
cd "$ROOT"  # radar resolves python3 -m radar relative to the repo root

# Tokens + ports come from the untracked live/.dev.vars (exported there).
# shellcheck disable=SC1091
source "$LIVE/.dev.vars"
SIDECAR="http://127.0.0.1:${SIDECAR_PORT:-8799}"
WORKER="http://127.0.0.1:${WORKER_PORT:-8787}"
UI_PORT="${UI_PORT:-8788}"
NODE_BIN="$(command -v node)"
# The sidecar requires a per-repo token on EVERY git endpoint (clone and fetch
# included, G2). Never let git fall back to an interactive username prompt:
# fail fast with the real HTTP error instead (process-env only, no git config).
export GIT_TERMINAL_PROMPT=0
export SIDECAR_PORT SIDECAR_HOST="127.0.0.1"
export SIDECAR_ROOT="$ART"
export SIDECAR_TOKEN
export SIDECAR_NOTIFY_URL="$WORKER/events/push"

SIDE_PIDS=()
# Dogfooding the process-hygiene rule (gap G1): every demo server starts in
# its own process group (setsid), only groups this script recorded are ever
# signalled, and only after the /proc cmdline matches the expected server and
# the target group is not our own. Killing the GROUP takes the wrangler CLI
# and its workerd child down together — no orphan keeps the port.
MY_PGID="$(ps -o pgid= -p $$ | tr -d ' ')"
safe_stop_group() { # pid expected_substring
  local pid="$1" want="$2" pgid cmd
  case "$pid" in ''|"$$") return 0 ;; esac
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  case "$cmd" in
    *"$want"*) : ;;
    *) log "safe_stop_group: pid $pid is not a '$want' server (cmdline: ${cmd:0:100}); leaving it alone"; return 0 ;;
  esac
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  if [ -z "$pgid" ]; then
    log "safe_stop_group: pid $pid already gone"; return 0
  fi
  if [ "$pgid" = "$MY_PGID" ]; then
    log "safe_stop_group: REFUSED — group $pgid is this script's own group"; return 0
  fi
  if [ "$pgid" != "$pid" ]; then
    # Not the setsid group leader we created; kill only the exact pid.
    log "safe_stop_group: pid $pid not a group leader (pgid=$pgid); signalling only the pid"
    kill -TERM "$pid" 2>/dev/null || true
    return 0
  fi
  if kill -TERM -- "-$pgid" 2>/dev/null; then
    log "safe_stop_group: TERM -> process group -$pgid ($want)"
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi
  for _ in $(seq 1 10); do
    kill -0 -- "-$pgid" 2>/dev/null || return 0
    sleep 1
  done
  if kill -0 -- "-$pgid" 2>/dev/null; then
    log "safe_stop_group: group -$pgid survived TERM; sending KILL"
    kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
}
port_holders() { # port -> log who listens (never kills)
  ss -ltnp "sport = :$1" 2>/dev/null | tail -n +2 | while read -r line; do
    log "port $1 still held: $line"
  done
}
cleanup() {
  for pid in "${SIDE_PIDS[@]:-}"; do
    case "${PID_WANT[$pid]:-}" in
      '') : ;;
      *) safe_stop_group "$pid" "${PID_WANT[$pid]}" ;;
    esac
  done
  # G1 assertion: after cleanup no demo port may stay held by a leftover child.
  for port in "${WORKER_PORT:-8787}" "${SIDECAR_PORT:-8799}" "${UI_PORT:-8788}"; do
    if ss -ltn "sport = :$port" 2>/dev/null | tail -n +2 | grep -q .; then
      port_holders "$port"
      log "WARN: port $port still held after cleanup (holders logged above)"
    fi
  done
}
trap cleanup EXIT

log() { echo "[run-demo $(date +%H:%M:%S)] $*"; }
step_done() { [ -f "$STATE/$1.done" ]; }
mark() { touch "$STATE/$1.done"; }

wait_for() { # url name tries [extra curl args...]
  local url="$1" name="$2" tries="${3:-60}"; shift 3
  for _ in $(seq 1 "$tries"); do
    if curl -sf --connect-timeout 2 --max-time 5 -o /dev/null "$url" "$@"; then return 0; fi
    sleep 1
  done
  echo "FATAL: $name did not come up at $url" >&2
  return 1
}

start_bg() { # logfile pidfile expected_substring cmd...
  local logfile="$1" pidfile="$2" want="$3"; shift 3
  # setsid: the child becomes leader of a fresh process group (pgid == pid),
  # so its whole tree (wrangler -> workerd, python http.server) dies with it.
  nohup setsid "$@" > "$logfile" 2>&1 < /dev/null &
  echo $! > "$pidfile"
  SIDE_PIDS+=("$(cat "$pidfile")")
  PID_WANT[$(cat "$pidfile")]="$want"
  log "started '$want' pid $(cat "$pidfile") (process group $(ps -o pgid= -p "$(cat "$pidfile")" 2>/dev/null | tr -d ' '))"
}

# Refuse to fight a port held by something that is NOT the expected healthy
# service: record the holder instead of guessing (G1).
assert_port_or_service() { # port health_url name [curl args...]
  local port="$1" url="$2" name="$3"; shift 3
  if ss -ltn "sport = :$port" 2>/dev/null | tail -n +2 | grep -q .; then
    if curl -sf --connect-timeout 2 --max-time 5 -o /dev/null "$url" "$@"; then
      log "$name already up on :$port"
      return 0
    fi
    log "FATAL precondition: port $port is held but $name does not answer; holders:"
    port_holders "$port"
    exit 1
  fi
  return 1
}

mem_guard() {
  local avail_kb
  avail_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
  if [ "$avail_kb" -lt $((2 * 1024 * 1024)) ]; then
    echo "FATAL: MemAvailable ${avail_kb}kB < 2GiB stop threshold" >&2
    exit 1
  fi
}

ADMIN_AUTH=(-H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json")
SIDECAR_AUTH=(-H "Authorization: Bearer $SIDECAR_TOKEN")
RUNNER_AUTH=(-H "Authorization: Bearer $RUNNER_TOKEN" -H "content-type: application/json")

mint_token() { # repo scope -> plaintext on stdout
  curl -sf -X POST "$SIDECAR/api/repos/$1/tokens" "${SIDECAR_AUTH[@]}" \
    -H 'content-type: application/json' \
    -d "{\"scope\":\"$2\",\"ttlSeconds\":3600}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["plaintext"])'
}

# ---------- 1. services (idempotent: skip if the port already serves) ----------

mem_guard

if assert_port_or_service "$SIDECAR_PORT" "$SIDECAR/api/health" sidecar \
    -H "Authorization: Bearer $SIDECAR_TOKEN"; then
  :
else
  log "starting L1 local-artifacts sidecar on :${SIDECAR_PORT}"
  start_bg "$LIVE/sidecar.log" "$STATE/sidecar.pid" local-artifacts \
    "$NODE_BIN" "$ROOT/prototype/local-artifacts/sidecar.mjs"
  wait_for "$SIDECAR/api/health" sidecar 30 -H "Authorization: Bearer $SIDECAR_TOKEN"
fi

if assert_port_or_service "$WORKER_PORT" "$WORKER/status" wrangler-dev; then
  :
else
  log "starting wrangler dev on :${WORKER_PORT}"
  NPX_BIN="$(command -v npx)"
  start_bg "$LIVE/wrangler.log" "$STATE/wrangler.pid" wrangler \
    bash -c "cd '$ROOT/prototype' && exec '$NPX_BIN' wrangler dev --local --port '$WORKER_PORT' \
    --var ADMIN_TOKEN:'$ADMIN_TOKEN' \
    --var RUNNER_TOKEN:'$RUNNER_TOKEN' \
    --var LOCAL_ARTIFACTS_URL:'$SIDECAR' \
    --var LOCAL_ARTIFACTS_TOKEN:'$SIDECAR_TOKEN' \
    --var RADAR_IMPL:silent"
  wait_for "$WORKER/status" wrangler-dev 180
fi

# ---------- 2. canonical repo seeded from demo-target (L1 documented flow) ----------
# POST /setup returns the canonical name (suffix -<8hex>) and remote; the seed
# is pushed with a per-repo WRITE token minted on the sidecar admin API.

if step_done canonical-seeded; then
  CANON="$(python3 -c 'import json; print(json.load(open("'"$EVIDENCE"'/setup.json"))["canonical"]["name"])')"
  if curl -sf "$SIDECAR/api/repos/$CANON/head" "${SIDECAR_AUTH[@]}" >/dev/null 2>&1; then
    log "skip: canonical seeded ($CANON still on the sidecar)"
  else
    log "marker canonical-seeded is stale ($CANON gone from sidecar); reseeding"
    rm -f "$STATE/canonical-seeded.done" "$STATE"/*.sha "$STATE"/task-*.json \
          "$STATE"/checks*.code "$STATE"/stale409.code
  fi
fi

if ! step_done canonical-seeded; then
  log "POST /setup (admin)"
  SETUP_CODE="$(curl -s -o "$EVIDENCE/setup.json" -w "%{http_code}" \
    -X POST "$WORKER/setup" "${ADMIN_AUTH[@]}")"
  [ "$SETUP_CODE" = "201" ] || [ "$SETUP_CODE" = "200" ] || {
    echo "FATAL: /setup returned $SETUP_CODE" >&2; cat "$EVIDENCE/setup.json"; exit 1; }
  CANON="$(python3 -c 'import json; print(json.load(open("'"$EVIDENCE"'/setup.json"))["canonical"]["name"])')"
  CANON_REMOTE="$(python3 -c 'import json; print(json.load(open("'"$EVIDENCE"'/setup.json"))["canonical"]["remote"])')"
  log "canonical repo: $CANON at $CANON_REMOTE"

  log "minting canonical write token (sidecar admin API)"
  CANON_TOKEN="$(mint_token "$CANON" write)"
  [ -n "$CANON_TOKEN" ] || { echo "FATAL: no canonical write token" >&2; exit 1; }
  umask 077; printf '%s' "$CANON_TOKEN" > "$STATE/canon.token"; umask 022

  log "cloning canonical + seeding from demo-target (excluding .harness)"
  rm -rf "$WORK/seed"
  git -c http.extraHeader="Authorization: Bearer $CANON_TOKEN" \
    clone -q "$CANON_REMOTE" "$WORK/seed"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude .git --exclude .harness "$ROOT/demo-target/" "$WORK/seed/"
  else
    ( shopt -s dotglob; find "$ROOT/demo-target" -maxdepth 1 \
        ! -name .git ! -name .harness -exec cp -a {} "$WORK/seed/" \; )
  fi
  git -C "$WORK/seed" add -A
  git -C "$WORK/seed" symbolic-ref HEAD refs/heads/main  # empty clones follow init.defaultBranch otherwise
  git -C "$WORK/seed" \
    -c user.name="demo-seed" -c user.email="seed@demo.agents" \
    commit -q -m "chore: canonical baseline from demo-target (no .harness)"
  git -C "$WORK/seed" -c http.extraHeader="Authorization: Bearer $CANON_TOKEN" push -q origin main
  git -C "$WORK/seed" rev-parse HEAD > "$STATE/base.sha"
  python3 -c 'import json; d=json.load(open("'"$EVIDENCE"'/setup.json")); d["seedCommit"]="'$(cat "$STATE/base.sha")'"; json.dump(d, open("'"$EVIDENCE"'/setup.json","w"), indent=2)'
  mark canonical-seeded
  log "canonical seeded at $(cat "$STATE/base.sha")"
fi
BASE_SHA="$(cat "$STATE/base.sha")"
CANON="$(python3 -c 'import json; print(json.load(open("'"$EVIDENCE"'/setup.json"))["canonical"]["name"])')"

# Markers are only valid for the canonical they were created against; a worker
# state reset produces a new canonical, so drop stale downstream markers.
if [ -f "$STATE/runid" ] && [ "$(cat "$STATE/runid")" != "$CANON" ]; then
  log "state belongs to canonical $(cat "$STATE/runid"), now $CANON — clearing stale markers"
  rm -f "$STATE"/*.done "$STATE"/*.sha "$STATE"/task-*.json \
        "$STATE"/checks*.code "$STATE"/stale409.code
fi
echo -n "$CANON" > "$STATE/runid"

# ---------- 3. create tasks T1..T3 (admin, with intent + base_sha) ----------
#
# Run-2 gap: tasks were created with intent "reference solution tN" and no
# base_sha, so the review UI showed "Not stated yet / not recorded". The
# intent now comes from the agent-facing task text (demo-target/TASKS.md) and
# base_sha pins the canonical base commit the fork was cut from.

task_intent() { # t1|t2|t3 -> one-line intent distilled from demo-target/TASKS.md
  python3 - "$ROOT/demo-target/TASKS.md" "$1" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
tid = sys.argv[2].upper()
head = re.search(rf"^## {tid} — (.+)$", text, re.M)
title = head.group(1).strip() if head else ""
# [^\n]* keeps the tests-to-add capture to ONE line (a DOTALL .* would
# swallow the rest of TASKS.md into the intent — seen on the run-3 screenshot).
tests = re.search(rf"^## {tid} —.*?^Tests to add: ([^\n]*)", text, re.S | re.M)
tests_line = tests.group(1).strip() if tests else ""
intent = f"{tid}: {title}"
if tests_line:
    intent += f" — tests to add: {tests_line}"
print(intent)
PY
}

task_body() { # t1|t2|t3 -> JSON body with agent, intent, base_sha
  local intent
  intent="$(task_intent "$1")"
  python3 -c 'import json, sys; print(json.dumps({"agent": sys.argv[1], "intent": sys.argv[2], "base_sha": sys.argv[3]}))' \
    "demo-$1" "$intent" "$BASE_SHA"
}

declare -A AGENT_ID FORK_NAME FORK_URL TOKEN TASK_ID
for t in t1 t2 t3; do
  if [ ! -f "$STATE/task-$t.json" ]; then
    log "creating task $t (intent from TASKS.md, base_sha $BASE_SHA)"
    task_body "$t" > "$STATE/task-$t.body.json"
    curl -sf -X POST "$WORKER/tasks" "${ADMIN_AUTH[@]}" \
      --data-binary "@$STATE/task-$t.body.json" > "$STATE/task-$t.json"
  fi
  TASK_ID[$t]="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['taskId'])" "$STATE/task-$t.json")"
  AGENT_ID[$t]="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['agentId'])" "$STATE/task-$t.json")"
  FORK_NAME[$t]="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['fork']['name'])" "$STATE/task-$t.json")"
  FORK_URL[$t]="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['fork']['remote'])" "$STATE/task-$t.json")"
  TOKEN[$t]="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['token']['plaintext'])" "$STATE/task-$t.json")"
  log "task ${TASK_ID[$t]} = agent ${AGENT_ID[$t]} (base_sha recorded)"
done

# ---------- 4. the 3 agents' pushes: apply reference patches ----------

for t in t1 t2 t3; do
  if step_done "pushed-$t"; then
    log "skip: $t pushed"
    continue
  fi
  log "agent ${AGENT_ID[$t]}: clone fork, apply $t patch, push"
  rm -rf "$WORK/$t"
  git -c http.extraHeader="Authorization: Bearer ${TOKEN[$t]}" \
    clone -q "${FORK_URL[$t]}" "$WORK/$t"
  # Idempotent re-runs: if a previous attempt died after the push but before
  # the marker, the fork already carries the patch — detect that instead of
  # failing on "patch does not apply".
  if git -C "$WORK/$t" apply --check -p2 "$ROOT/demo-target/.harness/reference-solutions/$t.patch" 2>/dev/null; then
    git -C "$WORK/$t" apply -p2 "$ROOT/demo-target/.harness/reference-solutions/$t.patch"
    git -C "$WORK/$t" add -A
    git -C "$WORK/$t" \
      -c user.name="demo-agent-$t" -c user.email="${t}@demo.agents" \
      commit -q -m "${t}: reference solution applied by agent harness"
    git -C "$WORK/$t" -c http.extraHeader="Authorization: Bearer ${TOKEN[$t]}" push -q origin main
  else
    git -C "$WORK/$t" apply --check --reverse -p2 \
      "$ROOT/demo-target/.harness/reference-solutions/$t.patch" \
      || { echo "FATAL: $t patch neither applies nor is already applied" >&2; exit 1; }
    log "$t patch already on the fork (previous attempt pushed it); reusing head"
  fi
  SHA="$(git -C "$WORK/$t" rev-parse HEAD)"
  echo "$SHA" > "$STATE/$t.sha"
  # Belt and braces: the sidecar post-receive hook also notifies /events/push;
  # the coordinator dedupes (agent, sha). AUTH (contract 0.1.1+): this route
  # is token-gated — the pushing agent authenticates with its own task token,
  # exactly like a real agent would.
  curl -sf -X POST "$WORKER/events/push" \
    -H "Authorization: Bearer ${TOKEN[$t]}" -H "content-type: application/json" \
    -d "{\"agent\":\"${AGENT_ID[$t]}\",\"sha\":\"$SHA\"}" > "$EVIDENCE/push-$t.json"
  mark "pushed-$t"
  log "$t pushed $SHA"
done

# ---------- helpers: radar run at a given vector ----------

run_radar() { # prefix head_t1 head_t2 head_t3
  local prefix="$1" h1="$2" h2="$3" h3="$4"
  rm -rf "$WORK/radar-repo"
  git init -q "$WORK/radar-repo"
  # fresh read tokens per pass: fork/canonical tokens minted at task time
  # expire after ttlSeconds=3600, and the sidecar 401s every unauthenticated
  # git read (G2)
  local CT FT
  CT="$(mint_token "$CANON" read)"
  git -C "$WORK/radar-repo" -c http.extraHeader="Authorization: Bearer $CT" \
    fetch -q "$SIDECAR/git/$CANON.git" "main:refs/heads/base"
  local t
  for t in t1 t2 t3; do
    FT="$(mint_token "${FORK_NAME[$t]}" read)"
    git -C "$WORK/radar-repo" -c http.extraHeader="Authorization: Bearer $FT" \
      fetch -q "${FORK_URL[$t]}" "main:refs/heads/${AGENT_ID[$t]}"
  done
  python3 -m radar \
    --repo "$WORK/radar-repo" \
    --base "$BASE_SHA" \
    --heads "${AGENT_ID[t1]}=$h1" "${AGENT_ID[t2]}=$h2" "${AGENT_ID[t3]}=$h3" \
    --test-cmd "$NODE_BIN --test" \
    --force-test --budget 120 --max-vmem 8192 \
    --l1 > "$EVIDENCE/$prefix-l1.json" 2> "$EVIDENCE/$prefix-radar.err"
  log "radar pass $prefix: $(python3 -c 'import json; d=json.load(open("'"$EVIDENCE"'/'"$prefix"'-l1.json")); print(" ".join(r["pair"][0]+"|"+r["pair"][1]+"="+r["status"]+(("/"+r["kind"]) if r.get("kind") else "") for r in d["results"]))')"
}

post_checks() { # radar_json out_file -> http code on stdout
  # Contract 0.1.2: POST /checks accepts the radar's typed payload DIRECTLY
  # (run-2 gaps G4/G5 closed): the payload declares "contract": "0.1", policy
  # is the {merge, tests} object, coverage the counts object, evidence the
  # typed per-result object. No down-conversion, no derived *.posted.json.
  local code
  code="$(curl -s -o "$2" -w "%{http_code}" -X POST "$WORKER/checks" \
    "${RUNNER_AUTH[@]}" --data-binary "@$1")"
  echo "$code"
}

# ---------- 5. radar pass 1 + POST /checks (expect 200) ----------

if step_done radar-1; then
  log "skip: radar pass 1"
else
  log "running radar pass 1 at the 3-agent vector"
  run_radar radar1 "$(cat "$STATE/t1.sha")" "$(cat "$STATE/t2.sha")" "$(cat "$STATE/t3.sha")"
  CODE="$(post_checks "$EVIDENCE/radar1-l1.json" "$EVIDENCE/checks1-receipt.json")"
  echo "$CODE" > "$STATE/checks1.code"
  [ "$CODE" = "200" ] || { echo "FATAL: /checks pass1 returned $CODE" >&2; cat "$EVIDENCE/checks1-receipt.json"; exit 1; }
  mark radar-1
fi

# ---------- 6. assertions phase 1 ----------

if step_done assert-1; then
  log "skip: assertions 1"
else
  curl -sf "$WORKER/status" > "$EVIDENCE/status-1.json"
  for t in t1 t2 t3; do
    curl -sf "$WORKER/tasks/$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['taskId'])" "$STATE/task-$t.json")" \
      > "$EVIDENCE/task-$t.json" || true
  done
  python3 "$LIVE/assertions.py" phase1 \
    --live "$LIVE" --evidence "$EVIDENCE" --state "$STATE" --status status-1.json | tee "$EVIDENCE/assertions-1.txt"
  mark assert-1
fi

# ---------- 7. stale probe: churn push on t1, replay old payload -> 409 ----------

if step_done stale-409; then
  log "skip: stale-409"
else
  log "churn push on t1, then replay old radar payload expecting 409"
  printf '\n<!-- churn %s -->\n' "$(date -Is)" >> "$WORK/t1/README.md"
  git -C "$WORK/t1" add -A
  git -C "$WORK/t1" \
    -c user.name="demo-agent-t1" -c user.email="t1@demo.agents" \
    commit -q -m "docs: churn commit to invalidate stale checks"
  git -C "$WORK/t1" -c http.extraHeader="Authorization: Bearer ${TOKEN[t1]}" push -q origin main
  T1_NEW_SHA="$(git -C "$WORK/t1" rev-parse HEAD)"
  echo "$T1_NEW_SHA" > "$STATE/t1.sha"
  curl -sf -X POST "$WORKER/events/push" \
    -H "Authorization: Bearer ${TOKEN[t1]}" -H "content-type: application/json" \
    -d "{\"agent\":\"${AGENT_ID[t1]}\",\"sha\":\"$T1_NEW_SHA\"}" > "$EVIDENCE/push-t1-churn.json"
  CODE="$(post_checks "$EVIDENCE/radar1-l1.json" "$EVIDENCE/stale-409.json")"
  echo "$CODE" > "$STATE/stale409.code"
  [ "$CODE" = "409" ] || { echo "FATAL: stale replay expected 409 got $CODE" >&2; cat "$EVIDENCE/stale-409.json"; exit 1; }
  mark stale-409
  log "stale replay correctly rejected with 409"
fi

# ---------- 8. radar pass 2 at the new vector ----------

if step_done radar-2; then
  log "skip: radar pass 2"
else
  log "running radar pass 2 after churn push"
  run_radar radar2 "$(cat "$STATE/t1.sha")" "$(cat "$STATE/t2.sha")" "$(cat "$STATE/t3.sha")"
  CODE="$(post_checks "$EVIDENCE/radar2-l1.json" "$EVIDENCE/checks2-receipt.json")"
  echo "$CODE" > "$STATE/checks2.code"
  [ "$CODE" = "200" ] || { echo "FATAL: /checks pass2 returned $CODE" >&2; cat "$EVIDENCE/checks2-receipt.json"; exit 1; }
  mark radar-2
fi

# ---------- 9. UI evidence: /status JSON + headless screenshots ----------

if step_done ui; then
  log "skip: ui evidence"
else
  log "capturing /status + UI screenshots (index + task page)"
  curl -sf "$WORKER/status" > "$EVIDENCE/status.json"
  if assert_port_or_service "$UI_PORT" "http://127.0.0.1:$UI_PORT/index.html" ui-server; then
    :
  else
    start_bg "$LIVE/ui-server.log" "$STATE/ui.pid" http.server \
      bash -c "cd '$ROOT/prototype/ui' && exec python3 -m http.server '$UI_PORT' --bind 127.0.0.1"
    wait_for "http://127.0.0.1:$UI_PORT/index.html" ui-server 30
  fi
  CHROME="$HOME/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell"
  "$CHROME" --headless --no-sandbox --disable-gpu --window-size=1440,1100 \
    --virtual-time-budget=15000 \
    --screenshot="$EVIDENCE/ui-index.png" \
    "http://127.0.0.1:$UI_PORT/index.html?api=http://127.0.0.1:$WORKER_PORT" \
    > "$LIVE/screenshot.log" 2>&1 || echo "WARN: index screenshot failed (see live/screenshot.log)"
  # Task page too (run-2 only screenshotted the index): the change story of the
  # agent whose task carries the T2 test conflict.
  TASK2_ID="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['taskId'])" "$STATE/task-t2.json")"
  echo "$TASK2_ID" > "$STATE/task2.taskid"
  "$CHROME" --headless --no-sandbox --disable-gpu --window-size=1440,1400 \
    --virtual-time-budget=15000 \
    --screenshot="$EVIDENCE/ui-task-$TASK2_ID.png" \
    "http://127.0.0.1:$UI_PORT/task.html?id=$TASK2_ID&api=http://127.0.0.1:$WORKER_PORT" \
    > "$LIVE/screenshot.log" 2>&1 || echo "WARN: task screenshot failed (see live/screenshot.log)"
  # Badge check: run the UI's own pair-status decision on the live /status so
  # assertions can pin what the badges show (conflict vs clean vs not checked).
  node "$LIVE/check-ui-pairs.cjs" "$EVIDENCE/status.json" > "$EVIDENCE/ui-pairs.json"
  mark ui
fi

# ---------- 10. final assertions ----------

mem_guard
curl -sf "$WORKER/status" > "$EVIDENCE/status.json"
python3 "$LIVE/assertions.py" final \
  --live "$LIVE" --evidence "$EVIDENCE" --state "$STATE" --status status.json \
  --result-out "$EVIDENCE/result.json" | tee "$EVIDENCE/summary.txt"
log "done. evidence in live/evidence/ (result.json, summary.txt, ui-index.png)"
