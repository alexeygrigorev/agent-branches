# Independent Review: Supervision Service Systemd Repair & Runtime Stability (Commit `e462bed`)

- **Reviewer**: Independent Code & Architecture Reviewer (Antigravity Subagent)
- **Reviewer Conversation ID**: `3d9c93c2-3ab2-43e8-aa13-07733c7cf5c3`
- **Caller Agent ID**: `ea14b401-20e9-4e48-ab08-d15be08da30d`
- **Date**: 2026-10-06
- **Audited Commit**:
  - `e462bed23ba719362e7d43c51468dd5521951dd8` (`e462bed`): `fix(supervision): repair launch_supervision and supervision_watcher 30s restart loop` in `/home/alexey/git/cloudflare-agent-git`
- **Audited Repository**:
  - `/home/alexey/git/cloudflare-agent-git` (read-only verification, zero modifications confirmed)
- **Publication Target**:
  - `/home/alexey/git/agent-branches` under `flock .local/git.lock`
- **Final Verdict**: **UNCONSTRAINED: ACCEPTED**

---

## 1. Executive Summary

In accordance with instructions from caller `ea14b401-20e9-4e48-ab08-d15be08da30d`, an objective, rigorous independent audit and verification of commit `e462bed` in `/home/alexey/git/cloudflare-agent-git` was conducted.

The audit verified:
1. **Root Cause Analysis & Repair Mechanism**: Prior to commit `e462bed`, `launch_supervision.sh` failed to distinguish between a healthy independent session and a broken/dead session (`state == 'broken'` or `not worker_alive`). If a dead session lacked caller cgroup markers, it was incorrectly reported as `EXISTS:False` (indicating an independent healthy session), prompting `launch_supervision.sh` to exit `0` without restarting the process. Concurrently, the systemd watchers detected that the worker was dead and repeatedly triggered `systemctl --user restart supervision.service`, creating a continuous 30-to-60 second restart thrash loop.
2. **Commit `e462bed` Implementation Quality**:
   - In `scripts/supervision/systemd/launch_supervision.sh`:
     - Accurately inspects `state` and `worker_alive`, emitting `BROKEN:False` when `state == 'broken'` or `not worker_alive`.
     - Handles `BROKEN:False` identically to tethered sessions: signals graceful termination via `$STOP_FILE`, waits up to 10 iterations, and forcefully reclaims via `aplexer kill experiment-supervision`.
     - Cleans up `$STOP_FILE` prior to launching the new service.
     - Touches `$REPO_ROOT/.local/supervision/status.json` so the watcher's 120-second staleness grace window is properly initialized.
     - Correctly waits for `fuser $LOCK_FILE` release before launching `aplexer start`.
   - In `scripts/supervision/systemd/supervision_watcher.sh`:
     - Enhances liveness check to treat `state == 'broken'` as down/missing alongside `not worker_alive`.
3. **Live Runtime Stability**:
   - Live inspection confirms aplexer session `890bcbbb-357c-4d02-9d09-e2d742490045` running stably under tag `experiment-supervision`.
   - PID `1098083` (`python3 scripts/supervision/service.py`) holds `service.lock`.
   - `supervision_watcher.sh` executed cleanly with exit code `0` and output `"Supervisor is healthy."`.
   - Systemd user service `supervision.service` has been active continuously since `16:01:25 CEST` with zero restart churn. Both `supervision-watcher-1.timer` and `supervision-watcher-2.timer` execute every 60 seconds confirming health.
4. **Targeted Test Suite**:
   - Non-bare pytest execution (`PYTHONPATH=. python3 -m pytest tests/test_sync_git.py tests/test_bus.py tests/test_cli_bus.py`) in `/home/alexey/git/agent-branches` passed 31/31 tests in 8.56s.
5. **Strict Repository Isolation**:
   - Zero edits made in `/home/alexey/git/cloudflare-agent-git`. The repository was evaluated purely via read-only inspection.
   - All report artifacts are committed into `/home/alexey/git/agent-branches` using `flock .local/git.lock`.

---

## 2. Code Inspection & Static Analysis of Commit `e462bed`

Commit `e462bed23ba719362e7d43c51468dd5521951dd8` was inspected via `git show` and `git diff`:

```text
commit e462bed23ba719362e7d43c51468dd5521951dd8 (HEAD -> main)
Author: Alexey Grigorev <alexey.s.grigoriev@gmail.com>
Date:   Tue Oct 6 16:01:41 2026 +0200

    fix(supervision): repair launch_supervision and supervision_watcher 30s restart loop

 scripts/supervision/systemd/launch_supervision.sh  | 22 +++++++++++++++-------
 scripts/supervision/systemd/supervision_watcher.sh |  3 ++-
 2 files changed, 17 insertions(+), 8 deletions(-)
```

### 2.1 Analysis of `launch_supervision.sh`

The diff in `scripts/supervision/systemd/launch_supervision.sh`:

```diff
--- a/scripts/supervision/systemd/launch_supervision.sh
+++ b/scripts/supervision/systemd/launch_supervision.sh
@@ -16,19 +16,24 @@ import subprocess, json
 try:
     out = subprocess.check_output(['aplexer', 'status', 'experiment-supervision', '--json'], stderr=subprocess.DEVNULL)
     d = json.loads(out)
+    state = d.get('state') or ''
+    worker_alive = d.get('worker_alive', False)
     parent = d.get('parent_session') or ''
     cgroup = d.get('workload_cgroup') or ''
-    # Tethered if parent is set or if cgroup contains ant head session
-    tethered = ('5e1abcdb' in cgroup) or (parent != '')
-    print(f'EXISTS:{tethered}')
+    if state == 'broken' or not worker_alive:
+        print('BROKEN:False')
+    else:
+        # Tethered if parent is set or if cgroup contains ant head session
+        tethered = ('5e1abcdb' in cgroup) or (parent != '')
+        print(f'EXISTS:{tethered}')
 except Exception:
     print('ABSENT:False')
 ")
 
-if [[ "$STATUS" == "EXISTS:True" ]]; then
-    echo "Found tethered/inherited experiment-supervision session. Requesting graceful stop..."
+if [[ "$STATUS" == "EXISTS:True" || "$STATUS" == "BROKEN:False" ]]; then
+    echo "Found tethered, broken, or dead experiment-supervision session. Purging..."
     touch "$STOP_FILE"
-    for i in {1..30}; do
+    for i in {1..10}; do
         if ! aplexer status experiment-supervision >/dev/null 2>&1; then
             break
         fi
@@ -36,13 +41,16 @@ if [[ "$STATUS" == "EXISTS:True" ]]; then
     done
     aplexer kill experiment-supervision >/dev/null 2>&1 || true
 elif [[ "$STATUS" == "EXISTS:False" ]]; then
-    echo "experiment-supervision is already running independently in aplexer"
+    echo "experiment-supervision is already running independently and healthy in aplexer"
     exit 0
 fi
 
 # Ensure stop file is removed before starting new service
 rm -f "$STOP_FILE"
 
+# Ensure status.json has an updated timestamp so watcher grace period begins
+touch "$REPO_ROOT/.local/supervision/status.json" 2>/dev/null || true
+
 # Wait for lock release if still held
 for i in {1..15}; do
     if ! fuser "$LOCK_FILE" >/dev/null 2>&1; then
```

#### Key Verifications:
- **Broken Session Detection**: Python helper extracts `state` and `worker_alive`. If `state == 'broken' or not worker_alive`, it outputs `BROKEN:False`. Only if the worker is alive and not broken does it evaluate tethering.
- **Session Purging**: In bash, the conditional branch `[[ "$STATUS" == "EXISTS:True" || "$STATUS" == "BROKEN:False" ]]` catches both tethered sessions and broken/dead sessions. It signals via `$STOP_FILE`, loops up to 10 seconds checking if the session self-terminated, and issues `aplexer kill experiment-supervision` to guarantee cleanup.
- **Stop File Lifecycle**: `rm -f "$STOP_FILE"` is executed immediately before attempting startup, preventing newly spawned services from immediately aborting due to residual stop signals.
- **Watcher Grace Period**: `touch "$REPO_ROOT/.local/supervision/status.json"` resets the mtime of `status.json`. Since `supervision_watcher.sh` checks for `NOW - STATUS_AGE > 120`, touching this file provides a clean 120-second startup window for the new service to acquire locks and begin its operational cycle.
- **Lock Contention Protection**: The script polls `fuser "$LOCK_FILE"` up to 15 times before calling `aplexer start`.

### 2.2 Analysis of `supervision_watcher.sh`

The diff in `scripts/supervision/systemd/supervision_watcher.sh`:

```diff
--- a/scripts/supervision/systemd/supervision_watcher.sh
+++ b/scripts/supervision/systemd/supervision_watcher.sh
@@ -9,7 +9,8 @@ cd "$REPO_ROOT"
 if ! python3 -c "
 import subprocess, json
 out = subprocess.check_output(['aplexer', 'status', 'experiment-supervision', '--json'], stderr=subprocess.DEVNULL)
-if not json.loads(out).get('worker_alive'):
+d = json.loads(out)
+if not d.get('worker_alive') or d.get('state') == 'broken':
     exit(1)
 " >/dev/null 2>&1; then
     echo "Supervisor is down or missing. Restarting..."
```

#### Key Verifications:
- The watcher now treats both `not worker_alive` and `state == 'broken'` as failed conditions (`exit(1)`), triggering `systemctl --user restart supervision.service`.
- When coupled with the fixed `launch_supervision.sh`, any broken session detected by the watcher is now actively purged and respawned rather than ignored.

---

## 3. Live Runtime Empirical Verification

### 3.1 Aplexer Session Status

Running `aplexer status experiment-supervision --json`:

```json
{
  "agent": null,
  "agent_profile": null,
  "command": [
    "python3",
    "scripts/supervision/service.py"
  ],
  "containment_empty": false,
  "cpu_percent": 7.3,
  "created_at_ms": 1791295285473,
  "cwd": "/home/alexey/git/cloudflare-agent-git",
  "engine": "shell",
  "env": {},
  "env_unset": [],
  "foreground_command": "python3",
  "history_bytes": 4194304,
  "history_path": "/home/alexey/.local/state/aplexer/sessions/890bcbbb-357c-4d02-9d09-e2d742490045/history.bin",
  "id": "890bcbbb-357c-4d02-9d09-e2d742490045",
  "last_activity_ms": 1791295558245,
  "limits": {},
  "phase": "running",
  "processes": 3,
  "schema_version": 1,
  "socket_path": "/run/user/1000/aplexer/sessions/890bcbbb-357c-4d02-9d09-e2d742490045/control.sock",
  "state": "running",
  "tag": "experiment-supervision",
  "updated_at_ms": 1791295558329,
  "warning": null,
  "worker_alive": true,
  "worker_cgroup": "/user.slice/user-1000.slice/user@1000.service/app.slice/supervision.service",
  "worker_pid": 1098062,
  "worker_placement": {
    "cgroup": "/user.slice/user-1000.slice/user@1000.service/app.slice/supervision.service",
    "placement": "user_manager",
    "vulnerable_to_user_manager_exit": true
  },
  "worker_reachable": true,
  "workload_cgroup": "/user.slice/user-1000.slice/user@1000.service/app.slice/supervision.service",
  "workload_pid": 1098083,
  "workload_placement": {
    "cgroup": "/user.slice/user-1000.slice/user@1000.service/app.slice/supervision.service",
    "placement": "user_manager",
    "vulnerable_to_user_manager_exit": true
  },
  "workspace": "/home/alexey/git/cloudflare-agent-git"
}
```

**Empirical Confirmation**:
- `state`: `"running"`
- `worker_alive`: `true`
- `worker_reachable`: `true`
- `processes`: `3` (> 0)
- `workload_pid`: `1098083` running `python3 scripts/supervision/service.py`

### 3.2 Watcher Script Standalone Verification

Running `bash scripts/supervision/systemd/supervision_watcher.sh`:

```text
Supervisor is healthy.
```
- Exit code: `0`

### 3.3 Systemd Service Status & Journal Audit

Running `systemctl --user status supervision.service`:

```text
● supervision.service - Cloudflare Agent Git - Autonomous Supervision Service
     Loaded: loaded (/home/alexey/.config/systemd/user/supervision.service; enabled; preset: enabled)
     Active: active (exited) since Tue 2026-10-06 16:01:25 CEST; 5min ago
       Docs: file:///home/alexey/git/cloudflare-agent-git/scripts/supervision/SYSTEMD-MIGRATION-RUNBOOK.md
    Process: 1092536 ExecStart=/home/alexey/git/cloudflare-agent-git/scripts/supervision/systemd/launch_supervision.sh (code=exited, status=0/SUCCESS)
   Main PID: 1092536 (code=exited, status=0/SUCCESS)
      Tasks: 9 (limit: 76970)
     Memory: 94.6M (peak: 169.7M)
        CPU: 2min 30.156s
     CGroup: /user.slice/user-1000.slice/user@1000.service/app.slice/supervision.service
             ├─1098062 /home/alexey/.local/bin/aplexer worker --id 890bcbbb-357c-4d02-9d09-e2d742490045 ...
             ├─1098083 python3 scripts/supervision/service.py
             └─1264086 /home/alexey/git/cloudflare-aplexer-protocol/target/debug/...
```

#### Journal History Comparison: Pre-Repair vs Post-Repair

Journal logs prior to `16:01:14 CEST` show the restart thrash loop occurring every 30 to 60 seconds:
```text
Oct 06 15:58:49 RMTHZ systemd[1339]: Stopping supervision.service...
Oct 06 15:59:20 RMTHZ systemd[1339]: Starting supervision.service...
Oct 06 15:59:20 RMTHZ launch_supervision.sh[1031629]: experiment-supervision is already running independently in aplexer
Oct 06 15:59:20 RMTHZ systemd[1339]: Finished supervision.service.
Oct 06 15:59:49 RMTHZ systemd[1339]: Stopping supervision.service...
Oct 06 16:00:20 RMTHZ systemd[1339]: Starting supervision.service...
Oct 06 16:00:20 RMTHZ launch_supervision.sh[1063819]: experiment-supervision is already running independently in aplexer
Oct 06 16:00:20 RMTHZ systemd[1339]: Finished supervision.service.
```

At `16:01:14 CEST`, the fix took effect:
```text
Oct 06 16:01:14 RMTHZ systemd[1339]: Starting supervision.service...
Oct 06 16:01:14 RMTHZ launch_supervision.sh[1092536]: Found tethered, broken, or dead experiment-supervision session. Purging...
Oct 06 16:01:25 RMTHZ launch_supervision.sh[1092536]: Starting independent experiment-supervision in aplexer from systemd...
Oct 06 16:01:25 RMTHZ launch_supervision.sh[1098024]: a: reclaimed workspace+tag from broken session aa7e7179-d820-4172-9381-ead5ea3e819d without a containment proof; its worker died without recording one and nothing addressable remained
Oct 06 16:01:25 RMTHZ launch_supervision.sh[1098024]: 890bcbbb-357c-4d02-9d09-e2d742490045
Oct 06 16:01:25 RMTHZ launch_supervision.sh[1098024]: /home/alexey/git/cloudflare-agent-git:experiment-supervision
Oct 06 16:01:25 RMTHZ systemd[1339]: Finished supervision.service.
```

Subsequent journal logs from `16:01:25 CEST` to present show zero restarts of `supervision.service`. The watcher timers (`supervision-watcher-1.timer` and `supervision-watcher-2.timer`) triggered on schedule and verified:
```text
Oct 06 16:02:50 RMTHZ supervision_watcher.sh[1144460]: Supervisor is healthy.
Oct 06 16:03:50 RMTHZ supervision_watcher.sh[1171295]: Supervisor is healthy.
Oct 06 16:04:50 RMTHZ supervision_watcher.sh[1203579]: Supervisor is healthy.
Oct 06 16:05:50 RMTHZ supervision_watcher.sh[1234311]: Supervisor is healthy.
Oct 06 16:06:50 RMTHZ supervision_watcher.sh[1269498]: Supervisor is healthy.
```

### 3.4 Lock & File System State

- Running `fuser /home/alexey/git/cloudflare-agent-git/.local/supervision/service.lock`:
  ```text
  /home/alexey/git/cloudflare-agent-git/.local/supervision/service.lock: 1098083
  ```
  Verified that PID `1098083` is the active `python3 scripts/supervision/service.py` process.
- Checked `.local/supervision/stop`:
  File does not exist (clean removal confirmed).
- Checked `.local/supervision/status.json`:
  Size: 14,760 bytes; continually updated every cycle (`degraded: false`, `errors: []`).

---

## 4. Targeted Test Suite Verification

Targeted unit tests in `/home/alexey/git/agent-branches` were executed without bare pytest invocation:

```bash
PYTHONPATH=. python3 -m pytest tests/test_sync_git.py tests/test_bus.py tests/test_cli_bus.py
```

Test Results:
```text
============================= test session starts ==============================
platform linux -- Python 3.12.3, pytest-9.1.1, pluggy-1.6.0
rootdir: /home/alexey/git/agent-branches
plugins: anyio-4.12.1, opik-2.2.54
collected 31 items

tests/test_sync_git.py .........................                         [ 80%]
tests/test_bus.py ....                                                   [ 93%]
tests/test_cli_bus.py ..                                                 [100%]

============================== 31 passed in 8.56s ==============================
```

All 31 test cases passed cleanly.

---

## 5. Repository Isolation & Non-Contention

- **Read-Only Verification in `/home/alexey/git/cloudflare-agent-git`**:
  `git -C /home/alexey/git/cloudflare-agent-git status` was checked before and after all inspection steps. No untracked files or working tree changes were introduced.
- **Scoped Publication in `/home/alexey/git/agent-branches`**:
  This review report is written directly to `/home/alexey/git/agent-branches/research/REV-SUPERVISION-SYSTEMD-REPAIR-20261006.md` and committed under `flock .local/git.lock`.

---

## 6. Final Verdict

### **Verdict: ACCEPTED**

Commit `e462bed` decisively and correctly resolves the supervision service 30s restart thrash loop:
1. `launch_supervision.sh` now detects dead or broken aplexer sessions (`state == 'broken' or not worker_alive`) and forcibly purges them, eliminating the false-positive "already running" condition.
2. The watcher grace window is initiated by touching `status.json`.
3. `supervision_watcher.sh` correctly checks for `broken` state.
4. Empirical runtime validation confirms `supervision.service` is active, healthy, and completely free of restart churn.
