# Execution Receipt: Real Sessionless Model AgentBus Callback (C2925)

- **Date**: 2026-10-06T17:43:40Z / 19:43 CEST
- **Product**: AgentBus (`PocketShell-io/agent-bus`) / Cross-Computer Agent Coordination
- **Target Repository**: `/home/alexey/git/agent-bus` (commit [`0e0380d`](https://github.com/PocketShell-io/agent-bus/commit/0e0380d))
- **Receipt Location**: `/home/alexey/git/agent-branches/research/RECEIPT-MODEL-SESSIONLESS-BUS-CALLBACK-C2925.md`
- **Execution Script**: `/home/alexey/git/agent-bus/scripts/run_sessionless_model_callback.py`
- **Worker Model**: `Gemini 2.5 Pro` (Antigravity subagent `90ce79ab-ab4e-4014-b187-0e25fc0c39a7`, OS PID `3461361`)
- **Actor / Head**: `ant-head-never-timer-custody-20261006` [session `7d87f36b-8d02-4b46-8216-98d6dce3f990`]

---

## 1. Objective & Directives
In response to `codex-principal` C2924 and C2925:
> *"Real model performs useful work and sends progress/completion over Bus; no session needed... Need actual taskID/model firsttool+artifact then independent review -> next real task; another fixture does not advance gate."*

This receipt records an end-to-end, live LLM model invocation executing an assigned evaluation task on `FileBus` with sessionless identity, producing a cryptographic on-disk artifact, sending a completion reply envelope, and having the Head consume, validate, and durably ACK the outcome.

---

## 2. Sessionless Identity & Credential Isolation

- **Head Identity**: `76515bfc-bfd7-4287-ac82-51137657f978` (`agent_name: head-c2925`, device `standalone-device`, project `agent-bus`)
- **Worker Identity**: `0521b2eb-b0b0-48f0-b0ff-b907d6c18b3a` (`agent_name: worker-c2925`, sessionless: `session_id=None` rendering as `"-"`)
- **Credential Storage**:
  - Head: `/home/alexey/git/agent-bus/.local/bus_sessionless_c2925/head.cred.json` (permissions `0600`)
  - Worker: `/home/alexey/git/agent-bus/.local/bus_sessionless_c2925/worker.cred.json` (permissions `0600`)
- **Bus Store**: `/home/alexey/git/agent-bus/.local/bus_sessionless_c2925` (permissions `0700`)

---

## 3. Execution Lifecycle & Bus Messages

### Step 1: Head Task Backlog & Dispatch
- Task ID: `t-sessionless-eval-c2925`
- Task Type: `agent_bus_coverage_audit`
- Task Body: `"Execute standalone AgentBus test coverage audit and artifact digest production"`
- Dispatch Message ID: `655a46a7-aa52-4e18-bb9a-7be457823720`
- Target Recipient: Worker `0521b2eb-b0b0-48f0-b0ff-b907d6c18b3a`

### Step 2: Live Model Worker Execution
- Executing Subagent: `90ce79ab-ab4e-4014-b187-0e25fc0c39a7` (Gemini 2.5 Pro)
- Action: Worker inspected `worker.cred.json`, checked `FileBus` inbox, consumed and acknowledged dispatch message `655a46a7-aa52...`.
- Evaluation Executed: Verified invariants across `completion_callback.py`, `InotifyBusWatcher`, and `DigestValidator`.
- Artifact Created: `/home/alexey/git/agent-bus/.local/bus_sessionless_c2925/workspace/eval_output.json`
- Artifact SHA-256 Digest: `19cef39908b46de24b2c037a30b84ae5acb08ad40be3d7cc506bd5c86fd8ea62`
- Reply Message Dispatched: `8cc10645-2bcd-49c8-8432-25932bcf626a` (addressed to Head `76515bfc-bfd7...`)

### Step 3: Head Verification & Consumption
- Head inspected inbox on `FileBus`, consumed reply `8cc10645-2bcd-49c8-8432-25932bcf626a`.
- Cryptographic SHA-256 verification against actual disk bytes: **VALID** (`is_valid: true`).
- Head emitted durable ACK via `FileBus.ack()`.
- Task `t-sessionless-eval-c2925` transitioned to `completed`.

---

## 4. Verification Evidence & Telemetry

```json
{
  "init": {
    "status": "INIT_SUCCESS",
    "bus_dir": "/home/alexey/git/agent-bus/.local/bus_sessionless_c2925",
    "head_identity": "76515bfc-bfd7-4287-ac82-51137657f978",
    "worker_identity": "0521b2eb-b0b0-48f0-b0ff-b907d6c18b3a",
    "dispatched_count": 1,
    "task_id": "t-sessionless-eval-c2925"
  },
  "worker_model": {
    "status": "WORKER_SUCCESS",
    "worker_identity": "0521b2eb-b0b0-48f0-b0ff-b907d6c18b3a",
    "model_name": "Gemini 2.5 Pro (Antigravity subagent)",
    "os_pid": 3461361,
    "dispatch_message_id": "655a46a7-aa52-4e18-bb9a-7be457823720",
    "reply_message_id": "8cc10645-2bcd-49c8-8432-25932bcf626a",
    "artifact_path": "/home/alexey/git/agent-bus/.local/bus_sessionless_c2925/workspace/eval_output.json",
    "artifact_digest": "19cef39908b46de24b2c037a30b84ae5acb08ad40be3d7cc506bd5c86fd8ea62"
  },
  "head_consumption": {
    "status": "HEAD_CONSUMED",
    "head_identity": "76515bfc-bfd7-4287-ac82-51137657f978",
    "consumed_replies": 1,
    "is_valid": true,
    "error": "valid",
    "task_completed": true
  }
}
```

Status: **COMPLETED AND VERIFIED**. Ready for independent review.
