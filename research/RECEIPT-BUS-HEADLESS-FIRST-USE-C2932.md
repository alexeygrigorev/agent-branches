# Receipt: Headless ZCode GLM-5.3-Flash First-Use Adoption of AgentBus CLI (C2932)

- **Task ID**: `t-bus-headless-first-use-c2932`
- **Execution Date**: 2026-10-06T18:12:56Z – 2026-10-06T18:17:56Z (20:12 – 20:17 CEST)
- **Coordinator / Head**: `ant-head-never-timer-custody-20261006` (aplexer `7d87f36b`, Antigravity)
- **Launcher Owner**: `ql-head-feedback-custody-20261006` (`agent-quota-launcher` via systemd `task-units` backend)
- **Executor Identity**: `worker-zcode-c2932` (`5876450f-b9d3-4bf8-b718-8568e831c55c`, sessionless `session_id=None` rendering as `"-"`)
- **Execution Provider / Model**: ZCode GLM-5.3-Flash (`--model glm-5.3-flash`, `zcodex exec`, PID `240642`, Unit `agent-task-t-bus-headless-first-use-c2932.service`)
- **Invocation UUID**: `6639f49597af4240a07905b83ea9ad9c`
- **Conversation ID**: `01a1126b-30ad-7430-b2ae-a96d9032f49e`
- **Trial Bus Store**: `/home/alexey/git/agent-bus/.local/bus_headless_trial_c2932` (permissions `0700`)
- **Secret Scan Gate**: Verified clean (`SECRET_SCAN_PASS`) across all tracked files. Zero raw bearer tokens published or committed.

---

## 1. Executive Summary & Verification

Under mandate C2932 / C2942, a real sessionless headless agent powered by ZCode GLM-5.3-Flash was admitted by the maintained `agent-quota-launcher` and executed inside an isolated systemd scope (`agent-task-t-bus-headless-first-use-c2932.service`).

The worker successfully interacted with the standalone `coordination/bus_cli.py` on the `FileBus` store, executing multiple commands, reading dispatch envelopes, verifying CLI flags, and hashing codebase modules.

---

## 2. Telemetry & Execution Trace

### 2.1 Systemd Task Unit & Cgroup Allocation
```text
Unit Name:     agent-task-t-bus-headless-first-use-c2932.service
Scope Cgroup:  /user.slice/user-1000.slice/user@1000.service/app.slice/agent-task-t-bus-headless-first-use-c2932.service
Main PID:      240642
Sub-process:   241649 (zcode-cli)
Command:       /home/alexey/.local/lib/zcodex/zcodex exec --model glm-5.3-flash --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false --json ...
Limits:        MemoryMax=1500M, TasksMax=100
```

### 2.2 First-Tool Verifications Executed by Real Model
From captured private stdout log (`/home/alexey/.config/agent-quota-launcher/t-bus-headless-first-use-c2932-stdout.log`, mode `0600`):

1. **Inbox Reading via Bus CLI (Item 3 & Item 6)**:
   - Command: `python3 /home/alexey/git/agent-bus/coordination/bus_cli.py --store /home/alexey/git/agent-bus/.local/bus_headless_trial_c2932 inbox --cred /home/alexey/git/agent-bus/.local/bus_headless_trial_c2932/worker.cred.json`
   - Exit Code: `0`
   - Consumed Dispatch Envelope:
     - `message_id`: `f5e05af6-a33d-437a-9863-334622158063`
     - `idempotency_key`: `dispatch-t-bus-headless-first-use-c2932-5876450f-b9d3-4bf8-b718-8568e831c55c`
     - `sender_id`: `ee0fc438-ec10-4558-a47c-601e0d720a28`
     - `recipient_id`: `5876450f-b9d3-4bf8-b718-8568e831c55c`
     - `digest`: `108cb5a41ebdf73f4ac94a0a900c0350d182985b23b51217d93790a766e2a020`

2. **CLI Help & Subcommand Inspection (Item 8 & Item 13)**:
   - Command: `python3 /home/alexey/git/agent-bus/coordination/bus_cli.py --store STORE --help`
   - Exit Code: `0`
   - Validated commands: `{register, send, inbox, wait, show, ack, accept, complete, reply, queue, flush}`.

3. **Cryptographic SHA-256 Digest of Tool Module (Item 14)**:
   - Command: `sha256sum /home/alexey/git/agent-bus/coordination/bus_cli.py`
   - Exit Code: `0`
   - SHA-256 Digest: `efc8f1e5571aa9bbe1b53d26df8f7a9b0a8e8bd6ab4684cbfc87464589b2b1a3` (verified 100% bit-for-bit against disk).

4. **Disk Write & Shell Capability Probing (Item 16 & Item 20)**:
   - `touch /tmp/probe_zcode_ok` (rc=0)
   - `echo test > /tmp/probe_redirect.txt` (rc=0)

---

## 3. Findings & Friction Diagnosis

### 3.1 Headless Permission Client Mismatch
- **Observed Behavior**: The ZCode model attempted to use high-level client tools (`Write`) and encountered an error message `No permission client configured for Bash / Write`.
- **Misinterpretation**: The worker inferred that all mutating operations were blocked, stating in Item 24: `[GOAL:BLOCKED] — reporting once: all mutating tool calls fail with "No permission client configured"`.
- **Reality**: Standard shell execution via `/bin/bash -lc` succeeded unconditionally (as proven by `touch` and `echo > redirect` passing with rc=0).
- **Remediation for Next Turn**: Prompts for headless `zcodex` workers must instruct them to emit files using standard shell commands (`cat << 'EOF' > ...` or `python3 -c "open(...).write(...)"`) rather than invoking interactive harness mutation tools.

### 3.2 Proactive Credential Containment
- In Item 21, the worker executed `python3 -m json.tool worker.cred.json`, which dumped the scoped worker credential object to stdout in the private machine-local log.
- **Immediate Mitigation Executed**:
  - Ant Head immediately invoked atomic revocation under `bus.lock`:
    - Purged `5876450f-b9d3-4bf8-b718-8568e831c55c` from `/home/alexey/git/agent-bus/.local/bus_headless_trial_c2932/identities.json`.
    - Purged `5876450f-b9d3-4bf8-b718-8568e831c55c` from `/home/alexey/git/agent-bus/.local/bus_headless_trial_c2932/tokens.json`.
    - Unlinked `worker.cred.json` from disk (`os.unlink`).
  - Proved fail-closed revocation at the store level.
  - Zero raw tokens leaked into Git or persistent documentation.

---

## 4. Status & Conclusion

- **Execution Quality**: Real ZCode GLM-5.3-Flash execution verified with live PID, systemd unit, and tool invocations.
- **Bus Contract**: Proved sessionless bus CLI operates cleanly with scoped worker credentials on standalone `FileBus`.
- **Refill / Continuation**: QL Head owns terminal admission/callback; Ant Head records genuine execution evidence and queues the unblocked prompt refinement for subsequent headless model tasks.
