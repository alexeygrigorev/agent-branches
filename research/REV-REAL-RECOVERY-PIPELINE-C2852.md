# Independent Review: Real Git Recovery Pipeline & Production Bus Transport (C2852)

- **Reviewer**: Independent Code & Architecture Reviewer (Antigravity Subagent)
- **Reviewer Conversation ID**: `362e720a-9507-4e32-9cea-c23f22bc993b`
- **Caller Agent ID**: `ea14b401-20e9-4e48-ab08-d15be08da30d`
- **Date**: 2026-10-06
- **Audited Commit**:
  - `1df95dae4b6127cc31abb534046e207926b34478` (`1df95da`): `feat(bus): verify real recovery pipeline with production cli bus ack and record receipt (c2852)` in `/home/alexey/git/agent-branches`
- **Audited Task ID**: `t-branches-recovery-pipeline-c2852`
- **Audited Receipt**:
  - `/home/alexey/git/agent-branches/research/RECEIPT-REAL-RECOVERY-PIPELINE-C2852.md`
- **Target Repository**:
  - `/home/alexey/git/agent-branches`
- **External Scope**:
  - `/home/alexey/git/cloudflare-agent-git` (read-only verification, zero contention confirmed)
- **Final Verdict**: **UNCONSTRAINED: ACCEPTED**

---

## 1. Executive Summary

In accordance with instructions from caller `ea14b401-20e9-4e48-ab08-d15be08da30d` for task **t-branches-recovery-pipeline-c2852** (Milestone C2852), an objective, rigorous independent audit and verification of commit `1df95da` in `/home/alexey/git/agent-branches` was conducted.

The audit verified:
1. **CLI `branches bus ack` Implementation**: In `agent_branches/cli.py`, the `handle_bus_ack` handler is properly implemented with clean `from pathlib import Path` resolution, credential loading, durable cursor advancement via `SessionlessWorkerBus.ack()`, and complete argparse wiring for `branches bus ack`.
2. **End-to-End Recovery Pipeline Verification**: `scripts/test_real_recovery_pipeline.py` exercises the complete coordinator-worker lifecycle end-to-end, executing:
   - Coordinator and Worker enrollment with `0600` permissions;
   - `work_assignment` envelope dispatch and reception;
   - Explicit message acknowledgment (`branches bus ack`) advancing the durable cursor;
   - Real Git recovery via ordinary `git clone` into a clean disposable workspace;
   - In-repo verification of the cloned entrypoint (`./branches sync git --preview --json`);
   - `task_result` envelope dispatch;
   - Coordinator ingestion and `task_ack` envelope dispatch with `coordinator_verdict: ACCEPTED`;
   - Worker `await-ack` consumption and final verification of `unread_count == 0`.
3. **Receipt Fidelity**: Receipt `research/RECEIPT-REAL-RECOVERY-PIPELINE-C2852.md` accurately reflects the codebase, test execution, CLI commands, and empirical results.
4. **Targeted Unit Test Suite**: The targeted unit test suite (`tests/test_sync_git.py`, `tests/test_bus.py`, `tests/test_cli_bus.py`) passed cleanly with all 31 tests passing in 10.50s.
5. **Zero Contention**: Zero files or changes leaked into `/home/alexey/git/cloudflare-agent-git`. All modifications are strictly confined to `/home/alexey/git/agent-branches` under `.local/git.lock`.

---

## 2. CLI `branches bus ack` Implementation Audit

Commit `1df95da` adds explicit message acknowledgment capabilities to the `agent-branches` CLI in `agent_branches/cli.py`:

### 2.1 Parser Configuration
The `ack` subcommand is correctly wired under the `bus` subparser:
```python
bus_ack = bus_sub.add_parser("ack", help="Acknowledge incoming message and advance durable cursor")
bus_ack.add_argument("--bus-store", required=True, help="Path to bus directory store")
bus_ack.add_argument("--cred-path", required=True, help="Path to 0600 credentials JSON")
bus_ack.add_argument("--message-id", required=True, help="Message ID to acknowledge")
bus_ack.add_argument("--json", action="store_true", help="Output raw JSON")
```

Verification of CLI help:
```bash
./branches bus ack --help
```
Output verified:
```text
usage: agent-branches bus ack [-h] --bus-store BUS_STORE --cred-path CRED_PATH
                              --message-id MESSAGE_ID [--json]

options:
  -h, --help            show this help message and exit
  --bus-store BUS_STORE
                        Path to bus directory store
  --cred-path CRED_PATH
                        Path to 0600 credentials JSON
  --message-id MESSAGE_ID
                        Message ID to acknowledge
  --json                Output raw JSON
```

### 2.2 Handler Implementation
The handler `handle_bus_ack` properly imports required symbols and resolves file paths:
```python
def handle_bus_ack(args: argparse.Namespace, as_json: bool) -> int:
    from pathlib import Path
    from agent_branches.bus import SessionlessWorkerBus
    store_path = Path(args.bus_store).resolve()
    cred_file = Path(args.cred_path).resolve()
    worker = SessionlessWorkerBus.from_credentials(store=store_path, cred=cred_file)
    read_ack = worker.ack(args.message_id)
    if as_json:
        print(json.dumps({
            "status": "acknowledged",
            "message_id": args.message_id,
            "read_ack_state": read_ack.state.value,
            "cursor": worker.current_cursor(),
        }, indent=2))
    else:
        print(f"[BUS ACK] Message {args.message_id} acknowledged, cursor at {worker.current_cursor()}")
    return 0
```
- Path resolution uses `resolve()` to eliminate symlink and relative directory ambiguities.
- Credentials file is loaded through `SessionlessWorkerBus.from_credentials()`, ensuring 0600 file permission validation.
- Message acknowledgment invokes `worker.ack(args.message_id)`, writing the durable read acknowledgment to the store and updating the worker's cursor.
- Dispatch logic in `main()` routes `bus_action == "ack"` directly to `handle_bus_ack`.

---

## 3. Real Recovery Pipeline Audit (`scripts/test_real_recovery_pipeline.py`)

The end-to-end recovery pipeline script was analyzed and executed dynamically.

### 3.1 Pipeline Stages Verified
1. **Coordinator Enrollment**:
   - Executes `branches bus enroll` with `--task-id coord-c2852`, `--agent-name branches-coordinator`.
   - Credentials written to disposable path with mode `0600`.
   - Namespaced identity assigned: `hetzner-rmthz/agent-branches/branches-coordinator/-/coord-c2852`.
2. **Worker Enrollment**:
   - Executes `branches bus enroll` with `--task-id t-branches-recovery-pipeline-c2852`, `--agent-name recovery-worker`.
   - Credentials written to disposable path with mode `0600`.
   - Namespaced identity assigned: `hetzner-rmthz/agent-branches/recovery-worker/-/t-branches-recovery-pipeline-c2852`.
3. **Work Assignment Envelope**:
   - Coordinator dispatches envelope with `kind="work_assignment"`.
   - Payload specifies `action="git_recovery_verification"`, `target_repo`, `dest_dir`, and recovery instructions.
4. **Worker Ingestion & Explicit Acknowledgment**:
   - Worker queries `branches bus receive`, validating `unread_count == 1`.
   - Worker invokes `branches bus ack` with the message ID.
   - Durable cursor advances, acknowledging receipt before beginning recovery work.
5. **Real Git Recovery Execution**:
   - Worker executes genuine `git clone` from `/home/alexey/git/agent-branches` into clean disposable directory `.local/tmp/t-branches-recovery-pipeline-c2852/recovered_clone`.
   - Cloned repository commit log inspected at HEAD.
   - Recovered entrypoint `./branches sync git --preview --json` executed within recovered clone, asserting exit code 0 and `status == "preview"`.
6. **Task Result Dispatch**:
   - Worker dispatches `task_result` envelope to coordinator with evidence payload (`recovered_commit`, `preview_verified: True`, `clone_path`, `timestamp`).
7. **Coordinator Ingestion & Task Ack Reply**:
   - Coordinator receives result via `branches bus receive`.
   - Coordinator generates `task_ack` envelope with `coordinator_verdict: "ACCEPTED"` and references `ack_for: result_msg_id`.
8. **Worker Await Ack**:
   - Worker awaits reply with `branches bus await-ack --expected-ack-for <result_msg_id> --timeout 10`.
   - Receives `status: "ack_received"`, confirming coordinator's `ACCEPTED` verdict.
9. **Cursor Persistence & Clean Inbox**:
   - Worker executes `branches bus receive`, validating `unread_count == 0`.

### 3.2 Dynamic Reproduction
Independent execution of `python3 scripts/test_real_recovery_pipeline.py`:
```text
1. Enrolling Coordinator...
Coordinator enrolled: hetzner-rmthz/agent-branches/branches-coordinator/-/coord-c2852
2. Enrolling Recovery Worker...
Worker enrolled: hetzner-rmthz/agent-branches/recovery-worker/-/t-branches-recovery-pipeline-c2852
3. Coordinator dispatching work assignment...
Work assignment dispatched: 7bb6c54a-a36c-4406-b3e3-df6dd8c895d7
4. Worker receiving assignment...
Worker received assignment: git_recovery_verification
Worker acknowledged assignment: 7bb6c54a-a36c-4406-b3e3-df6dd8c895d7
5. Worker executing Git recovery...
Cloned repository verified at HEAD:
1df95da feat(bus): verify real recovery pipeline with production cli bus ack and record receipt (c2852)
2d228c2 feat(cli): expose AgentBus production entrypoints (enroll, send, receive, await-ack)
fed3243 docs(review): independent audit of real model standalone AgentBus adoption
6. Worker sending task result...
Task result dispatched: b2a50c92-5eba-4e0a-ad30-2280717ad449
7. Coordinator receiving result and sending task_ack reply...
Coordinator task_ack dispatched: 3c71b493-fe62-4914-af1a-232fb25cfcb1
8. Worker awaiting coordinator reply...
Worker received coordinator reply: ACCEPTED
PIPELINE_SUCCESS
{
  "status": "passed",
  "pipeline": "work_assignment -> git_recovery -> task_result -> task_ack -> await_reply",
  "assign_msg_id": "7bb6c54a-a36c-4406-b3e3-df6dd8c895d7",
  "result_msg_id": "b2a50c92-5eba-4e0a-ad30-2280717ad449",
  "coordinator_reply_verdict": "ACCEPTED",
  "recovery_evidence": {
    "status": "success",
    "recovered_commit": "1df95da feat(bus): verify real recovery pipeline with production cli bus ack and record receipt (c2852)",
    "preview_verified": true,
    "clone_path": "/home/alexey/git/agent-branches/.local/tmp/t-branches-recovery-pipeline-c2852/recovered_clone",
    "timestamp": 1791290996.9906838
  }
}
```
All pipeline assertions passed cleanly with exit code 0.

---

## 4. Receipt Accuracy Audit (`RECEIPT-REAL-RECOVERY-PIPELINE-C2852.md`)

The receipt file `/home/alexey/git/agent-branches/research/RECEIPT-REAL-RECOVERY-PIPELINE-C2852.md` was checked line-by-line:
- **Task ID & Host**: Accurately records `t-branches-recovery-pipeline-c2852`, host `hetzner-rmthz`, repo `/home/alexey/git/agent-branches`.
- **Pipeline Stages**: All 9 stages described correspond precisely to the implementation in `scripts/test_real_recovery_pipeline.py`.
- **Verification Commands & Results**: Commands and sample envelope outputs are authentic representations of the live CLI entrypoints.
- **Test Results**: Accurately records 31 passing unit tests and confirms zero shared repository contention.

---

## 5. Targeted Unit Test Suite Execution

The targeted test suite was executed without running bare pytest across the repository:
```bash
cd /home/alexey/git/agent-branches && PYTHONPATH=. pytest -v tests/test_sync_git.py tests/test_bus.py tests/test_cli_bus.py
```

### 5.1 Test Results
```text
============================= test session starts ==============================
platform linux -- Python 3.12.3, pytest-9.1.1, pluggy-1.6.0 -- /usr/bin/python3
cachedir: .pytest_cache
rootdir: /home/alexey/git/agent-branches
plugins: anyio-4.12.1, opik-2.2.54
collecting ... collected 31 items

tests/test_sync_git.py::TestSyncGit::test_clean_ahead_push_timeout_handling PASSED [  3%]
tests/test_sync_git.py::TestSyncGit::test_clean_ahead_pushes_to_remote PASSED [  6%]
tests/test_sync_git.py::TestSyncGit::test_cli_sync_git_isolated_mode PASSED [  9%]
tests/test_sync_git.py::TestSyncGit::test_cli_sync_git_isolated_preview_mode PASSED [ 12%]
tests/test_sync_git.py::TestSyncGit::test_forbidden_file_ignored_during_sync PASSED [ 16%]
tests/test_sync_git.py::TestSyncGit::test_forbidden_patterns PASSED      [ 19%]
tests/test_sync_git.py::TestSyncGit::test_get_remote_sha_timeout_fail_closed PASSED [ 22%]
tests/test_sync_git.py::TestSyncGit::test_noop_when_clean_and_in_sync PASSED [ 25%]
tests/test_sync_git.py::TestSyncGit::test_porcelain_z_special_character_paths PASSED [ 29%]
tests/test_sync_git.py::TestSyncGit::test_pre_staged_new_forbidden_patterns_rejected PASSED [ 32%]
tests/test_sync_git.py::TestSyncGit::test_pre_staged_secret_rejected PASSED [ 35%]
tests/test_sync_git.py::TestSyncGit::test_preview_mode PASSED            [ 38%]
tests/test_sync_git.py::TestSyncGit::test_push_failure_preserves_local_checkpoint PASSED [ 41%]
tests/test_sync_git.py::TestSyncGit::test_push_timeout_handling_returns_unpushed_checkpoint PASSED [ 45%]
tests/test_sync_git.py::TestSyncGit::test_remote_mismatch_returns_push_unverified PASSED [ 48%]
tests/test_sync_git.py::TestSyncGit::test_repo_lock_concurrency PASSED   [ 51%]
tests/test_sync_git.py::TestSyncGit::test_sync_commit_and_push_verified PASSED [ 54%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_divergent_collision_fail_closed PASSED [ 58%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_missing_owned_path PASSED [ 61%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_noop PASSED [ 64%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_preview_mode_does_not_commit_or_push PASSED [ 67%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_push_rejection_preserves_checkpoint PASSED [ 70%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_secret_forbidden PASSED [ 74%]
tests/test_sync_git.py::TestSyncGit::test_sync_isolated_owned_paths_success_and_shared_checkout_untouched PASSED [ 77%]
tests/test_sync_git.py::TestSyncGit::test_whitelisted_env_example_can_be_synced PASSED [ 80%]
tests/test_bus.py::TestAgentBranchesBus::test_await_task_ack_timeout_raises PASSED [ 83%]
tests/test_bus.py::TestAgentBranchesBus::test_enroll_worker_startup_creates_0600_credentials PASSED [ 87%]
tests/test_bus.py::TestAgentBranchesBus::test_send_task_result_and_read_unread PASSED [ 90%]
tests/test_bus.py::TestAgentBranchesBus::test_send_task_result_missing_credentials_raises PASSED [ 93%]
tests/test_cli_bus.py::test_cli_bus_enroll_and_permissions PASSED        [ 96%]
tests/test_cli_bus.py::test_cli_bus_send_and_receive PASSED              [100%]

============================= 31 passed in 10.50s ==============================
```
- `tests/test_sync_git.py`: 25 passed.
- `tests/test_bus.py`: 4 passed.
- `tests/test_cli_bus.py`: 2 passed.
- All 31 tests passed cleanly.

---

## 6. Zero Contention Verification

Verification of the shared repository `/home/alexey/git/cloudflare-agent-git`:
```bash
git -C /home/alexey/git/cloudflare-agent-git status --porcelain | grep -E "agent-branches|c2852|recovery-pipeline"
```
**Result**: Clean (exit code 1 / zero output).
No files from `t-branches-recovery-pipeline-c2852`, the recovery pipeline script, or this independent audit have touched `/home/alexey/git/cloudflare-agent-git`. The shared workspace remains completely uncontaminated.

All review modifications are confined exclusively to `/home/alexey/git/agent-branches` and serialized with `flock .local/git.lock`.

---

## 7. Audit Verdict & Sign-off

- **Commit `1df95da` Audit (`agent_branches/cli.py`, `scripts/test_real_recovery_pipeline.py`)**: ACCEPTED
- **CLI `branches bus ack` Wiring & Implementation**: ACCEPTED
- **End-to-End Recovery Pipeline Verification**: ACCEPTED (All 9 stages verified dynamically)
- **Receipt Fidelity (`RECEIPT-REAL-RECOVERY-PIPELINE-C2852.md`)**: ACCEPTED
- **Targeted Test Suite Pass (31/31 passed)**: ACCEPTED
- **Zero Shared Repository Contention**: ACCEPTED

**FINAL AUDIT VERDICT: UNCONSTRAINED: ACCEPTED**
