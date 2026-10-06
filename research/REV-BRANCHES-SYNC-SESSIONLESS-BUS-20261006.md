# Independent Review: Sessionless AgentBus Callback Pipeline for Branches Dogfood Sync (C3021 / C3022)

- **Reviewer**: Independent Code & Architecture Reviewer (Antigravity Subagent)
- **Reviewer Conversation ID**: `4eb549ad-f90a-4c61-a1db-0a231b7f5888`
- **Caller Agent ID**: `ea14b401-20e9-4e48-ab08-d15be08da30d`
- **Review Date**: 2026-10-06
- **Task ID**: `t-branches-sync-sessionless-bus`
- **Intake Reference**: C2786 / C3021 / C3022
- **Audited Commit**: [`ce0b6c8396df9a75adbb5732f91a6c60757b6b9f`](file:///home/alexey/git/agent-branches) (`ce0b6c8`) in `/home/alexey/git/agent-branches`
- **Audited Files**:
  - Script: [`scripts/run_branches_sessionless_sync.py`](file:///home/alexey/git/agent-branches/scripts/run_branches_sessionless_sync.py)
  - Tests: [`tests/test_sessionless_sync.py`](file:///home/alexey/git/agent-branches/tests/test_sessionless_sync.py)
  - Receipt: [`research/RECEIPT-BRANCHES-SYNC-SESSIONLESS-BUS-20261006.md`](file:///home/alexey/git/agent-branches/research/RECEIPT-BRANCHES-SYNC-SESSIONLESS-BUS-20261006.md)
- **Target Repository**: `/home/alexey/git/agent-branches`
- **Shared Repository Contention**: `/home/alexey/git/cloudflare-agent-git` verified read-only with zero modifications.
- **Final Verdict**: **ACCEPTED** (Unconstrained)

---

## 1. Executive Summary & Review Scope

This independent audit conducts an objective, rigorous verification of commit `ce0b6c8` in `/home/alexey/git/agent-branches`, which implements the **Sessionless Model AgentBus Callback Pipeline** for `agent-branches` dogfood sync (intake references C2786 / C3021 / C3022).

### 1.1 Context & Problem Statement
In earlier runs under interactive model harnesses, workers faced timeout loops and permission-probing hallucinations on empty Linux outputs (such as attempting unsupported tool calls). Codex Principal directive C3021 mandated a non-identical, changed eligible execution route. 

The implementation in `ce0b6c8` adheres directly to the admitted sessionless worker execution pattern (C2925 / C2932 / C3021):
1. **Head Initialization**: The Head initializes a local `FileBus` store with mode `0700`, registers the Head and a sessionless Worker (`session_id=None` rendering as `-` in registration logs), writes credentials with mode `0600`, and dispatches the task specification envelope to the worker inbox.
2. **Worker Execution**: The sessionless worker loads its `0600` credentials, reads and ACKs the dispatch envelope, executes the genuine 3-stage dogfood sync pipeline (`run_dogfood_pipeline()`), writes the execution artifact to disk, computes its SHA-256 digest, and sends an authenticated completion reply envelope to the Head.
3. **Head Consumption & Verification**: The Head consumes the reply envelope, loads raw disk bytes from the reported artifact path, cryptographically verifies the reported SHA-256 against actual disk bytes (failing closed on missing files or digest mismatch), ACKs the reply, and confirms all 3 dogfood stages passed (`preview`, `isolated_push`, `remote_recovery`, `leakage_clean: true`).

---

## 2. Detailed Technical Audit of Implementation

### 2.1 FileBus Architecture & Credentials Isolation (`scripts/run_branches_sessionless_sync.py`)
- **Directory Security**: In `cmd_head_init`, both the bus directory (`bus_dir`) and workspace directory (`ws_dir`) are explicitly created with mode `0700` (`os.chmod(bus_dir, 0o700)`).
- **Credentials Protection**: `head.cred.json` and `worker.cred.json` are written and explicitly chmodded to `0600` (`os.chmod(head_cred_file, 0o600)`), preventing unauthorized reading by other OS users.
- **Sessionless Registration**: Both identities are registered via `FileBus.register()`. As verified in `/home/alexey/git/agent-bus/coordination/bus.py`, identities are bus-native and do not depend on an interactive aplexer session ID; unattached workers naturally run with `session_id=None`.
- **Task Dispatch**: The task envelope (`kind="task_dispatch"`) contains explicit task metadata (`task_id: "t-branches-sync-sessionless-bus"`, `pipeline: "dogfood"`, `owned_path: "research"`, `required_output: "sync_dogfood_output.json"`) and an idempotency key.

### 2.2 Worker Execution & Dogfood Pipeline
- **Credential Loading & ACK**: `cmd_worker_exec` parses `worker.cred.json`, authenticates to `FileBus`, retrieves the unread inbox message, and sends an immediate ACK (`bus.ack`).
- **Real Dogfood Pipeline Execution**: The worker invokes `run_dogfood_pipeline()` from `scripts.dogfood_branches_sync`, which executes real Git plumbing:
  1. *Preview Mode*: Runs `sync_isolated_owned_paths(..., preview=True)`, verifying that owned paths are inspected without creating remote branches or modifying the local shared checkout HEAD.
  2. *Isolated Push*: Applies changes using an isolated index and pushes to the bare upstream repository without advancing the working tree checkout HEAD, ensuring peer dirty files (`peer_work.txt`) remain uncommitted and untouched.
  3. *Remote Recovery & Leakage*: Clones the pushed branch into a separate recovery directory, checks out the exact SHA-256 content digest, and asserts that peer dirty files never leaked into the remote branch (`leakage_clean: true`).
- **Artifact Generation & SHA-256 Hashing**: The complete pipeline output is written to `sync_dogfood_output.json` in the workspace directory. The SHA-256 digest is computed using buffered 64KB reads (`file_sha256(art_file)`).
- **Reply Transmission**: The completion envelope (`kind="task_reply"`) is sent back to the Head referencing the original dispatch message ID (`reply_to=dispatch_msg.message_id`).

### 2.3 Head Consumption & Cryptographic Verification
- **Fail-Closed Verification**: In `cmd_head_consume`:
  - If the reported artifact path does not exist on disk, it raises `FileNotFoundError`.
  - The actual disk bytes are hashed via SHA-256: `actual_digest = file_sha256(art_path)`.
  - Equality is strictly checked: `if not is_valid: raise ValueError(f"Digest mismatch! Reported: {reported_digest}, Actual: {actual_digest}")`.
  - This ensures tamper-resistance: any bit-flip or corrupted write causes immediate hard failure.
- **Verification ACK**: Upon validating the digest, the Head ACKs the reply envelope and confirms that all three stages (`preview`, `isolated_push`, `remote_recovery`) passed.

---

## 3. Test Suite Audit (`tests/test_sessionless_sync.py`)

The test suite provides clean unit coverage without external dependencies or repo pollution:
1. `setUp` / `tearDown`: Uses `tempfile.TemporaryDirectory(prefix="test-sessionless-sync-")` to isolate bus and workspace files per test run.
2. `test_sessionless_sync_pipeline_end_to_end`:
   - Validates that `cmd_head_init` outputs `INIT_SUCCESS` and creates `0600` credential files.
   - Validates that `cmd_worker_exec` outputs `WORKER_SUCCESS`, creates the artifact, and produces a matching SHA-256 hash.
   - Validates that `cmd_head_consume` outputs `HEAD_CONSUMED`, confirms `is_valid == True`, `pipeline_success == True`, and verifies that all three stages passed (`PASSED`).
3. `test_sessionless_sync_tamper_fails_closed`:
   - Executes initialization and worker steps, then deliberately modifies the artifact file on disk (`payload["tampered"] = True`).
   - Asserts that `cmd_head_consume` raises `ValueError` with `"Digest mismatch"`.

---

## 4. Empirical Test & Verification Results

### 4.1 Unit Test Execution
Targeted pytest execution:
```bash
cd /home/alexey/git/agent-branches && PYTHONPATH=. pytest -v tests/test_sessionless_sync.py
```
Output:
```text
============================= test session starts ==============================
platform linux -- Python 3.12.3, pytest-9.1.1, pluggy-1.6.0 -- /usr/bin/python3
cachedir: .pytest_cache
rootdir: /home/alexey/git/agent-branches
plugins: anyio-4.12.1, opik-2.2.54
collecting ... collected 2 items

tests/test_sessionless_sync.py::TestSessionlessSyncBus::test_sessionless_sync_pipeline_end_to_end PASSED [ 50%]
tests/test_sessionless_sync.py::TestSessionlessSyncBus::test_sessionless_sync_tamper_fails_closed PASSED [100%]

============================== 2 passed in 1.21s ===============================
```
**Result**: 2/2 tests PASSED in 1.21s.

### 4.2 Full Pipeline Execution
Direct execution of the pipeline CLI:
```bash
cd /home/alexey/git/agent-branches && PYTHONPATH=. python3 scripts/run_branches_sessionless_sync.py --mode full-pipeline --json
```
Output:
```json
{
  "status": "FULL_PIPELINE_SUCCESS",
  "head_init": {
    "status": "INIT_SUCCESS",
    "bus_dir": "/home/alexey/git/agent-branches/.local/bus_sessionless_sync",
    "workspace_dir": "/home/alexey/git/agent-branches/.local/bus_sessionless_sync/workspace",
    "head_identity": "68f54f46-36a6-4a18-81ff-d81405ff4ddd",
    "worker_identity": "f9185de2-6d47-416b-b1dc-17da54cf8151",
    "dispatch_message_id": "0dfec240-1982-48f0-8980-bd4381de22e5",
    "task_id": "t-branches-sync-sessionless-bus"
  },
  "worker_exec": {
    "status": "WORKER_SUCCESS",
    "worker_identity": "f9185de2-6d47-416b-b1dc-17da54cf8151",
    "task_id": "t-branches-sync-sessionless-bus",
    "dispatch_message_id": "0dfec240-1982-48f0-8980-bd4381de22e5",
    "reply_message_id": "7f3395d4-b1b6-497c-a067-d290f6302932",
    "artifact_path": "/home/alexey/git/agent-branches/.local/bus_sessionless_sync/workspace/sync_dogfood_output.json",
    "artifact_digest": "cbf104c62909bd4f000909c74ba1d7b4ffdab0eab028f2ee4bd095f98defda66",
    "pipeline_success": true
  },
  "head_consume": {
    "status": "HEAD_CONSUMED",
    "head_identity": "68f54f46-36a6-4a18-81ff-d81405ff4ddd",
    "reply_message_id": "7f3395d4-b1b6-497c-a067-d290f6302932",
    "is_valid": true,
    "task_id": "t-branches-sync-sessionless-bus",
    "artifact_digest": "cbf104c62909bd4f000909c74ba1d7b4ffdab0eab028f2ee4bd095f98defda66",
    "pipeline_success": true,
    "stages": {
      "isolated_push": "PASSED",
      "preview": "PASSED",
      "remote_recovery": "PASSED"
    }
  }
}
```
**Independent Digest Verification**:
- Artifact path: `/home/alexey/git/agent-branches/.local/bus_sessionless_sync/workspace/sync_dogfood_output.json`
- Independent `sha256sum` output:
  `cbf104c62909bd4f000909c74ba1d7b4ffdab0eab028f2ee4bd095f98defda66`
- Matches reported `artifact_digest` with 100% cryptographic parity.

### 4.3 Secret Scan
Secret scanner execution:
```bash
python3 scripts/secret-scan.py --root /home/alexey/git/agent-branches
```
Output:
```text
SECRET_SCAN_PASS
tracked_files=245
```
**Result**: Clean pass across all 245 tracked repository files.

---

## 5. Non-Contention & Isolation Verification

- **Shared Repository Safety**: Verified that `/home/alexey/git/cloudflare-agent-git` was completely untouched by this review. No files in `cloudflare-agent-git` were modified, created, or deleted.
- **Local Git Repository State**: Verified that `/home/alexey/git/agent-branches` working tree was completely clean prior to authoring this review report.
- **Local Bus Ignore Rules**: Verified that `.local/bus_sessionless_sync` is gitignored by repository rules (`git check-ignore` confirms ignored status).

---

## 6. Audit Summary & Verdict

| Verification Item | Requirement | Observed Outcome | Status |
|:---|:---|:---|:---|
| Head Initialization (`cmd_head_init`) | Enrolls Head & sessionless worker, writes `0600` credentials, dispatches task | Successfully registered, credentials mode `0600`, task dispatched to FileBus | **PASSED** |
| Worker Execution (`cmd_worker_exec`) | Reads credentials, ACKs dispatch, runs 3-stage dogfood sync, produces artifact & SHA-256, replies | Full 3-stage sync executed, artifact written, SHA-256 computed, reply envelope sent | **PASSED** |
| Head Consumption (`cmd_head_consume`) | Loads credentials, reads reply, checks SHA-256 against disk bytes, fails closed on mismatch, ACKs | SHA-256 verified against disk bytes, fail-closed negative test verified, reply ACKed | **PASSED** |
| Automated Unit Tests | Targeted tests in `tests/test_sessionless_sync.py` | 2/2 passed (end-to-end + fail-closed bit-flip negative test) | **PASSED** |
| Direct Pipeline CLI | `run_branches_sessionless_sync.py --mode full-pipeline --json` | Status `FULL_PIPELINE_SUCCESS`, `is_valid: true`, all 3 stages `PASSED` | **PASSED** |
| Secret Scanning | `scripts/secret-scan.py --root .` | `SECRET_SCAN_PASS` (245 files) | **PASSED** |
| Contention Control | Zero modification to `/home/alexey/git/cloudflare-agent-git` | Fully maintained read-only isolation; zero shared repo edits | **PASSED** |

### Final Verdict: **ACCEPTED** (Unconstrained)

The implementation in commit `ce0b6c8` successfully resolves the harness permission-probing and timeout issues by routing through the deterministic sessionless AgentBus callback pattern, with strict `0600` credential isolation, cryptographic byte verification, and 100% pass across all 3 dogfood stages.
