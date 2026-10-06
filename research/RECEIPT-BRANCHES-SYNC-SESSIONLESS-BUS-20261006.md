# Receipt: Sessionless Model AgentBus Callback Execution for Branches Dogfood Sync (C2786 / C3021 / C3022)

- **Task ID**: `t-branches-sync-sessionless-bus`
- **Intake Reference**: C2786 / C3021 / C3022
- **Execution Date**: 2026-10-06T20:10:52Z (22:10:52 Europe/Berlin)
- **Supervising Head**: `ant-head-never-timer-custody-20261006` (`ea14b401-20e9-4e48-ab08-d15be08da30d`, aplexer `7d87f36b`)
- **FileBus Store**: `/home/alexey/git/agent-branches/.local/bus_sessionless_sync` (mode `0700`)
- **Workspace Directory**: `/home/alexey/git/agent-branches/.local/bus_sessionless_sync/workspace` (mode `0700`)
- **Head Identity**: `740f5021-a77b-40ce-b8b5-6f4949e99569` (credentials `0600`)
- **Sessionless Worker Identity**: `2c4eb313-92a0-4f2f-b91b-d74c58437d0f` (credentials `0600`, sessionless `session_id=None`)
- **Dispatch Message ID**: `f1987802-b1bb-40bb-a752-bc496a4546ef`
- **Reply Message ID**: `10c8d9e3-eeaf-4695-bdfc-c813da050415`
- **Artifact Path**: `/home/alexey/git/agent-branches/.local/bus_sessionless_sync/workspace/sync_dogfood_output.json`
- **Artifact SHA-256**: `fcf07f45ea876d4df6e237ca988b624e18dd4b009be9908acefbb1d9fc9aca6b`

---

## 1. Executive Summary

This receipt documents the successful execution and validation of the **Sessionless Model AgentBus Callback Pipeline** for `agent-branches` dogfood sync.

Responding to Codex Principal directive C3021 (which required a non-identical, changed eligible route addressing interactive model probing and harness timeout loops), this architecture routes execution through the admitted sessionless worker pattern (C2925 / C2932). Rather than relying on an open-ended interactive tool loop that triggers permission-probing hallucinations on empty Linux outputs, execution is driven by a deterministic, single-invocation structured callback:
1. **Head Initialization**: Enrolls Head and Sessionless Worker on `FileBus`, writes `0600` credentials, and dispatches the task specification.
2. **Worker Execution**: Sessionless worker loads `0600` credentials, ACKs the dispatch envelope, executes the complete 3-stage dogfood sync pipeline, produces an on-disk artifact, hashes it via SHA-256, and sends an authenticated completion envelope.
3. **Head Consumption**: Head receives the completion reply, verifies the cryptographic SHA-256 digest against actual on-disk bytes, ACKs the reply, and confirms all 3 stages PASSED.

---

## 2. Empirical Execution Evidence

### 2.1 Full Pipeline Execution Output
From `scripts/run_branches_sessionless_sync.py --mode full-pipeline --json`:

```json
{
  "status": "FULL_PIPELINE_SUCCESS",
  "head_init": {
    "status": "INIT_SUCCESS",
    "bus_dir": "/home/alexey/git/agent-branches/.local/bus_sessionless_sync",
    "workspace_dir": "/home/alexey/git/agent-branches/.local/bus_sessionless_sync/workspace",
    "head_identity": "740f5021-a77b-40ce-b8b5-6f4949e99569",
    "worker_identity": "2c4eb313-92a0-4f2f-b91b-d74c58437d0f",
    "dispatch_message_id": "f1987802-b1bb-40bb-a752-bc496a4546ef",
    "task_id": "t-branches-sync-sessionless-bus"
  },
  "worker_exec": {
    "status": "WORKER_SUCCESS",
    "worker_identity": "2c4eb313-92a0-4f2f-b91b-d74c58437d0f",
    "task_id": "t-branches-sync-sessionless-bus",
    "dispatch_message_id": "f1987802-b1bb-40bb-a752-bc496a4546ef",
    "reply_message_id": "10c8d9e3-eeaf-4695-bdfc-c813da050415",
    "artifact_path": "/home/alexey/git/agent-branches/.local/bus_sessionless_sync/workspace/sync_dogfood_output.json",
    "artifact_digest": "fcf07f45ea876d4df6e237ca988b624e18dd4b009be9908acefbb1d9fc9aca6b",
    "pipeline_success": true
  },
  "head_consume": {
    "status": "HEAD_CONSUMED",
    "head_identity": "740f5021-a77b-40ce-b8b5-6f4949e99569",
    "reply_message_id": "10c8d9e3-eeaf-4695-bdfc-c813da050415",
    "is_valid": true,
    "task_id": "t-branches-sync-sessionless-bus",
    "artifact_digest": "fcf07f45ea876d4df6e237ca988b624e18dd4b009be9908acefbb1d9fc9aca6b",
    "pipeline_success": true,
    "stages": {
      "isolated_push": "PASSED",
      "preview": "PASSED",
      "remote_recovery": "PASSED"
    }
  }
}
```

### 2.2 Three-Stage Dogfood Validation Results
1. **Stage 1 (Preview Mode)**: `PASSED`. Confirmed that isolated owned-path preview inspected `feature.py` without advancing shared checkout HEAD and without creating remote branches.
2. **Stage 2 (Isolated Push)**: `PASSED`. Confirmed plumbing-isolated commit was pushed to upstream branch without modifying local shared checkout.
3. **Stage 3 (Remote Recovery & Leakage)**: `PASSED`. Confirmed detached recovery clone checked out matching SHA-256 byte digest, verifying `leakage_clean: true` (zero leakage of peer uncommitted dirty files).

### 2.3 Automated Test Evidence
Automated regression tests in `tests/test_sessionless_sync.py`:
- `test_sessionless_sync_pipeline_end_to_end`: PASSED (verifies init, worker exec, head consume, 0600 file permissions, and all 3 stages).
- `test_sessionless_sync_tamper_fails_closed`: PASSED (verifies that artifact tampering / bit-flip fails closed with `ValueError: Digest mismatch`).

```
============================== 2 passed in 1.17s ===============================
```

---

## 3. Invariants & Safety Verification

1. **Deterministic Execution**: Bounded CLI wrapper eliminates interactive harness permission client errors (`unsupported call: Write`).
2. **Cryptographic Validation**: SHA-256 digest `fcf07f45ea876d4df6e237ca988b624e18dd4b009be9908acefbb1d9fc9aca6b` verified against raw disk bytes before task acceptance.
3. **File Security**: Private directories created with mode `0700`, credentials persisted with mode `0600`.
4. **Token Privacy**: Ephemeral credentials handled strictly in memory or in mode `0600` files; zero bearer tokens committed or published.
5. **Zero Shared Contention**: Zero modifications made to `/home/alexey/git/cloudflare-agent-git`.
