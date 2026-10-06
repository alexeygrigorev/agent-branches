# Receipt: Real Git Recovery Pipeline & Production Bus Transport (C2852)

**Date**: 2026-10-06  
**Task ID**: `t-branches-recovery-pipeline-c2852`  
**Host**: `hetzner-rmthz`  
**Repository**: `/home/alexey/git/agent-branches`  
**Bus Store**: `/home/alexey/git/agent-branches/.local/bus_pipeline`  

## 1. Executive Summary

This receipt documents the empirical end-to-end execution of the real coordinator-worker recovery pipeline using the production `agent-branches` CLI (`branches bus`). The pipeline demonstrates bidirectional communication, genuine Git recovery into a clean disposable workspace, verification of entrypoints, and durable cursor advancement with explicit message acknowledgments.

## 2. Pipeline Execution Sequence

### Step 1: Coordinator Enrollment
- Command: `branches bus enroll --bus-store .local/bus_pipeline --task-id coord-c2852 --cred-path coord.cred.json --agent-name branches-coordinator --json`
- Namespaced ID: `hetzner-rmthz/agent-branches/branches-coordinator/-/coord-c2852`
- File credentials: Mode `0600` created.

### Step 2: Worker Enrollment
- Command: `branches bus enroll --bus-store .local/bus_pipeline --task-id t-branches-recovery-pipeline-c2852 --cred-path worker.cred.json --agent-name recovery-worker --json`
- Namespaced ID: `hetzner-rmthz/agent-branches/recovery-worker/-/t-branches-recovery-pipeline-c2852`
- File credentials: Mode `0600` created.

### Step 3: Work Assignment Dispatch
- Coordinator sends envelope of kind `work_assignment` to worker:
  - Envelope ID: `eed19498-5664-45b5-a28f-adc397bb724f`
  - Action: `git_recovery_verification`
  - Target Repo: `/home/alexey/git/agent-branches`
  - Instructions: Clone repository into clean destination, verify commit history and `./branches` entrypoints.

### Step 4: Worker Ingestion & Acknowledgment
- Worker checks inbox: `branches bus receive --cred-path worker.cred.json --json`
  - `unread_count`: 1
- Worker explicitly acknowledges assignment:
  - Command: `branches bus ack --bus-store .local/bus_pipeline --cred-path worker.cred.json --message-id eed19498-5664-45b5-a28f-adc397bb724f --json`
  - Result: `status: acknowledged`, cursor advanced, `unread_count` decremented to 0.

### Step 5: Real Git Recovery Execution
- Worker clones repository into clean disposable directory:
  - Destination: `/home/alexey/git/agent-branches/.local/tmp/t-branches-recovery-pipeline-c2852/recovered_clone`
- Cloned HEAD verified:
  - `2d228c2 feat(cli): expose AgentBus production entrypoints (enroll, send, receive, await-ack)`
- Recovered CLI verified:
  - Command: `./branches sync git --preview --json` inside recovered clone
  - Status: `preview` (exit code 0).

### Step 6: Task Result Dispatch
- Worker sends envelope of kind `task_result` to coordinator:
  - Envelope ID: `cd1b5251-efbe-492f-b36c-22234496c1b1`
  - Payload includes recovered commit SHA, preview status, and clone path.

### Step 7: Coordinator Review & Reply (task_ack)
- Coordinator receives task result via `branches bus receive`.
- Coordinator evaluates recovery evidence and dispatches `task_ack` envelope:
  - Envelope ID: `4a31c380-2b61-4d3e-8c83-30aa579e84ba`
  - Verdict: `ACCEPTED`
  - `ack_for`: `cd1b5251-efbe-492f-b36c-22234496c1b1`.

### Step 8: Worker Awaits Coordinator Reply
- Worker awaits coordinator response:
  - Command: `branches bus await-ack --bus-store .local/bus_pipeline --cred-path worker.cred.json --expected-ack-for cd1b5251-efbe-492f-b36c-22234496c1b1 --timeout 10 --json`
  - Result: `status: ack_received`, `coordinator_verdict: ACCEPTED`.

### Step 9: Final Cursor Persistence Verification
- Worker runs `branches bus receive`:
  - `unread_count`: 0 (confirming full cursor advancement and no unread message accumulation).

## 3. Test Verification
- Targeted unit test suite:
  `PYTHONPATH=. pytest -v tests/test_sync_git.py tests/test_bus.py tests/test_cli_bus.py`
  Result: **31 passed in 10.44s**.
- Zero contention with shared repository `/home/alexey/git/cloudflare-agent-git` (`yours: none`).
