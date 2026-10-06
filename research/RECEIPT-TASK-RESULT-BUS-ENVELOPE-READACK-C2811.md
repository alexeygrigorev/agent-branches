# Receipt: Multi-Process Task Result AgentBus Envelope & ReadAck Verification (C2811)

- **Date**: 2026-10-06
- **Component**: `SessionlessWorkerBus` (`coordination/worker_bus.py`, `agent-bus/bus_envelope.py`)
- **Pinned Public Specification**: `12f9bde` / `main f918` (`agent-bus/bus_envelope.py`)
- **Task ID**: `t-bus-restore-c2808-v2`
- **Worker Namespaced ID**: `hetzner-rmthz/agent-branches/branches-restore-worker/-/t-bus-restore-c2808-v2`
- **Coordinator Namespaced ID**: `hetzner-rmthz/agent-branches/branches-coordinator/-/control`
- **Session Dependency**: **NONE** (`session_id=None`, rendered as `-`)
- **Execution Script**: `scratch/run_task_result_bus_transport.py`
- **Status**: **VERIFIED & PASSING (100%) ACROSS OS PROCESS BOUNDARY**

---

## 1. Multi-Process Architecture & Message Flow

Following Codex Principal directive `C2811`, this receipt provides empirical proof of authentic task result conveyance and explicit `ReadAck` receipt across distinct operating system processes using the enrolled `SessionlessWorkerBus`:

```
+-----------------------------------------------------------------------------------+
| OS Child Process 1 (Worker PID 3591976)                                           |
| - Registers bus-native identity (session_id=None)                                |
| - Writes 0600 disk credentials                                                    |
| - Carries actual model result payload for t-bus-restore-c2808-v2:                 |
|     * Target commit: 4fe9f1c9e68de9b34050e0568f27c2f421a635ac                     |
|     * Blob SHA1: 38fbe32ccdda10716eb67dad073c3a479714df0e                        |
|     * Blob SHA256: 722f32b59eb477e186b1efb402bd519dbba4e979f41b024679da06faf805eba7|
|     * Receipt commit: 0f5ca4a                                                    |
|     * Model: gemini-3.1-pro-high (conversation b5b0c195-35cb-4ab6-b1d1-18687cf1ab70) |
|     * Tokens: 65,426 (duration: 97.47s)                                          |
| - Formats and dispatches task_result envelope a36affef-9503-45f6-b12c-d1b49b5d1b0a  |
| - Validates public schema against pinned 12f9bde -> PASSED                       |
| - Process terminates cleanly (PID 3591976 dies)                                   |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v  [AgentBus Store: .local/bus]
+-----------------------------------------+-----------------------------------------+
| Coordinator Process (Head)                                                        |
| - Receives task_result envelope from branches-restore-worker                      |
| - Validates public schema against pinned 12f9bde -> PASSED                        |
| - Issues explicit ReadAck record: state=recipient_read_ack (2026-10-06T10:56:06Z)  |
| - Dispatches task_ack reply envelope: 444f7888-de0d-49dc-b914-d104edda2f23        |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v  [AgentBus Store: .local/bus]
+-----------------------------------------+-----------------------------------------+
| OS Child Process 2 (Worker PID 3592129, PID_2 != PID_1)                           |
| - Distinct Python subshell invocation                                             |
| - Reloads credentials from disk (SessionlessWorkerBus.from_credentials)          |
| - Confirms cursor store persistence (zero duplicate re-delivery of sent result)   |
| - Receives Coordinator task_ack message (444f7888-de0d-49dc-b914-d104edda2f23)   |
| - Asserts correlation: ack_for == a36affef-9503-45f6-b12c-d1b49b5d1b0a           |
| - Asserts verdict: METADATA_CHECKPOINT_RESTORE_CONFIRMED                          |
| - Process terminates cleanly (PID 3592129 dies)                                   |
+-----------------------------------------------------------------------------------+
```

---

## 2. Empirical Verification Evidence

1. **Process Isolation**:
   - `PID_1` (3591976) and `PID_2` (3592129) executed as distinct OS processes (`PID_2 != PID_1`), both exiting with returncode 0.
2. **Real Task Evidence**:
   - The dispatched payload carried genuine verified metadata from task `t-bus-restore-c2808-v2`, including commit `4fe9f1c9e68de9b34050e0568f27c2f421a635ac` and verified content SHA256 `722f32b59eb477e186b1efb402bd519dbba4e979f41b024679da06faf805eba7`.
3. **Envelope Schema Validation**:
   - Both worker `task_result` envelope (`a36affef-9503-45f6-b12c-d1b49b5d1b0a`) and coordinator `task_ack` envelope (`444f7888-de0d-49dc-b914-d104edda2f23`) passed `validate_bus_envelope` against pinned specification `12f9bde`.
4. **Explicit ReadAck State**:
   - Coordinator emitted an explicit `recipient_read_ack` at `2026-10-06T10:56:06Z` via `coordinator.ack()`.
5. **Cursor Persistence**:
   - Process 2 re-opened the worker bus with clean cursor persistence, verifying `unread_count == 1` and receiving solely the newly issued coordinator `task_ack`.
6. **Zero Interactive Session Leak**:
   - `namespaced_id` renders as `hetzner-rmthz/agent-branches/branches-restore-worker/-/t-bus-restore-c2808-v2`, with `session_id=None` strictly enforced.

---

## 3. Conclusion & Verdict

The authenticated transport of actual task execution results, explicit recipient ReadAck, and durable cursor recovery via `SessionlessWorkerBus` is fully confirmed.
