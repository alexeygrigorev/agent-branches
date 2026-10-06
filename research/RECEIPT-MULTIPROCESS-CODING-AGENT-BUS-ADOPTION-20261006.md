# Receipt: Multi-Process Coding-Agent AgentBus Adoption Verification

- **Date**: 2026-10-06
- **Component**: `SessionlessWorkerBus` (`coordination/worker_bus.py`, `coordination/envelope.py`)
- **Pinned Public Specification**: `12f9bde` / `main f918` (`agent-bus/bus_envelope.py`)
- **Worker Identity**: `branches-mp-coding-worker`
- **Rendered Namespaced ID**: `hetzner-rmthz/agent-branches/branches-mp-coding-worker/-/task-sync-git-audit-verification`
- **Session Dependency**: **NONE** (`session_id=None`, renders as `-`)
- **Harness Script**: `scratch/run_multiprocess_coding_agent_bus_adoption.py`
- **Audit Classification Reference**: [`research/REV-SESSIONLESS-HEADLESS-AGENTBUS-ADOPTION-20261006.md`](file:///home/alexey/git/agent-branches/research/REV-SESSIONLESS-HEADLESS-AGENTBUS-ADOPTION-20261006.md) (commit `5f50f46`)
- **Status**: **VERIFIED & PASSING (100%) ACROSS OS PROCESS BOUNDARY**

---

## 1. Multi-Process Execution Architecture

Following peer and principal review (`C2775`, `C2778`), this receipt establishes empirical proof of **true multi-process coding-agent adoption** across operating system process boundaries:

```
+-----------------------------------------------------------------------------------+
| OS Child Process 1 (Worker PID_1)                                                 |
| - Registers bus-native identity (session_id=None)                                |
| - Writes 0600 disk credentials                                                    |
| - Executes REAL code verification on agent_branches/sync_git.py                    |
| - Dispatches task_result envelope to AgentBus                                     |
| - Validates envelope against 12f9bde schema -> PASSED                             |
| - Process terminates cleanly (PID_1 dies)                                         |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v  [AgentBus Store]
+-----------------------------------------+-----------------------------------------+
| Coordinator Process (Head)                                                        |
| - Receives task_result envelope from branches-mp-coding-worker                    |
| - Validates public schema against 12f9bde -> PASSED                               |
| - Issues explicit ReadAck record (TransportState.RECIPIENT_READ_ACK)              |
| - Dispatches task_ack reply envelope back to worker                               |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v  [AgentBus Store]
+-----------------------------------------+-----------------------------------------+
| OS Child Process 2 (Worker PID_2, PID_2 != PID_1)                                 |
| - Separate Python subshell invocation                                            |
| - Reloads credentials from disk (SessionlessWorkerBus.from_credentials)          |
| - Confirms cursor store persistence (zero duplicate delivery of sent result)      |
| - Receives Coordinator task_ack message                                           |
| - Asserts correct correlation (ack_for == msg_id1)                                |
| - Process terminates cleanly (PID_2 dies)                                         |
+-----------------------------------------------------------------------------------+
```

---

## 2. Empirical Verification Evidence

1. **OS Process Separation**:
   - `PID_1` and `PID_2` executed as separate OS processes via `subprocess.run([sys.executable, ...])`.
   - Verified `PID_2 != PID_1` and both exited with returncode 0.
2. **Real Coding Task Execution**:
   - Inspected `agent_branches/sync_git.py` to confirm `.dev.vars` blocking (`is_forbidden(".dev.vars") == True`) and safe source file allowance (`is_forbidden("tokenizer.py") == False`).
   - Recorded latest Git commit metadata in payload.
3. **Public Envelope Compliance**:
   - Verified by `validate_bus_envelope` from `agent-bus` (commit `12f9bde` / `main f918`).
4. **Zero Aplexer Interactive Session Leaks**:
   - `namespaced_id.session_id is None`, rendered as `-`.
5. **Durable Cursor Across Process Death/Restart**:
   - `PID_2` reloaded credentials and read the bus without re-consuming its own prior sent message.

---

## 3. Verdict & Conclusion

The transition from in-process protocol compatibility (`2c317b6`) to true multi-process coding-agent adoption is complete and verified across distinct OS execution contexts.
