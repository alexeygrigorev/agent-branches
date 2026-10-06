# Execution Receipt: Real Model Standalone AgentBus Adoption (C2847)

- **Date**: 2026-10-06 14:15 UTC
- **Task ID**: `t-bus-model-standalone-c2847`
- **Controller Unit**: `ql-ctl-t-bus-model-standalone-c2847.service` (exited 0)
- **Task Unit**: `agent-task-t-bus-model-standalone-c2847.service` under `app.slice` (exited 0)
- **Model / Runtime**: `gemini-3.1-pro-high` (`agy`, PID 1675414, memory peak ~120M, cgroup TasksMax=100)
- **Target Repository**: `/home/alexey/git/agent-bus` (commit [`9c7c693`](https://github.com/PocketShell-io/agent-bus/commit/9c7c693))

---

## 1. Verified Execution & Module Isolation
The model task executed under an isolated cgroup unit with clean `PYTHONPATH=/home/alexey/git/agent-bus`. It verified that:
1. `sys.path` contains zero references to `cloudflare-agent-git` or `agent-coordination`.
2. `sys.modules` contains zero legacy `agent_coordination` references.
3. Loaded module origins are strictly inside `/home/alexey/git/agent-bus/coordination/`:
   - `coordination.worker_bus`: `/home/alexey/git/agent-bus/coordination/worker_bus.py`
     - SHA256: `1e900571f0e1b1035dc99b3b61d499cc3efd8bf9710058a4ba3333e44eff6345`
   - `coordination.namespaced`: `/home/alexey/git/agent-bus/coordination/namespaced.py`
     - SHA256: `973135e555d7ef1130f8e86634be963ccdc25ec48b5260cf8ed01773f827b387`
   - `coordination.bus`: `/home/alexey/git/agent-bus/coordination/bus.py`
     - SHA256: `f994bd0cdf939d958127d5dd396f2677901aa6f06e2862c5393b042faae30d57`
   - `coordination.cursors`: `/home/alexey/git/agent-bus/coordination/cursors.py`
     - SHA256: `0570a59b774ea86ae51d20cb3b293f558d08232db984b96910031fcfc94775d4`

## 2. Bus Operation & Durability Proof
- **Worker Identity**: `standalone-device/agent-bus/receiver-worker/-/t-isolation-recv` (sessionless, `session_id=None` renders as `"-"`).
- **Disk Credentials**: Mode `0600` at `/home/alexey/git/agent-bus/.local/isolation_test/worker.cred.json`.
- **Message Dispatched**: `ada2c5c5-aa67-4dab-941e-fd9fd4c5bd73` with `idempotency_key="ac-isolation-001"`.
- **Recipient ReadAck**: Received and explicitly acknowledged with `ReadAck` receipt (`TransportState.RECIPIENT_READ_ACK`).
- **Cursor Persistence Across Termination**:
  - Worker process terminated.
  - Re-instantiated via `SessionlessWorkerBus.from_credentials(...)`.
  - Re-read cursor verified at `ada2c5c5-aa67-4dab-941e-fd9fd4c5bd73`.
  - Remaining unread count is `0`.

## 3. Test Suite Pass
- All 39 unit tests in `agent-bus` pass cleanly (`PYTHONPATH=. pytest -v tests/`).
- All 29 unit tests in `agent-branches` pass cleanly (`PYTHONPATH=. pytest -v tests/test_sync_git.py tests/test_bus.py`).
- Zero shared repository contention: `git -C /home/alexey/git/cloudflare-agent-git status --porcelain` is clean (`(yours: none)`).
