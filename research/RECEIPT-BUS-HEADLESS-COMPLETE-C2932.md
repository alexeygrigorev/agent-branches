# Receipt: Real Headless ZCode GLM-5.3-Flash End-to-End Adoption of AgentBus CLI (C2932-Resumed)

- **Task ID**: `t-bus-headless-first-use-c2932`
- **Execution Turn**: C2950 / C2953 / C2957 resumed turn
- **Execution Date**: 2026-10-06T18:26:09Z – 2026-10-06T18:30:52Z (20:26 – 20:30 CEST)
- **Coordinator / Head**: `ant-head-never-timer-custody-20261006` (aplexer `7d87f36b`, Antigravity)
- **Launcher Owner**: `ql-head-feedback-custody-20261006` (`agent-quota-launcher` via systemd `task-units` backend)
- **Executor Identity**: `worker-zcode-c2950-resumed` (`907d0c3a-5824-42cf-befd-1e4d2cd474d5`, sessionless `session_id=None` rendering as `"-"`)
- **Head Identity**: `head-trial-c2932` (`ee0fc438-ec10-4558-a47c-601e0d720a28`)
- **Execution Provider / Model**: ZCode GLM-5.3-Flash (`--model glm-5.3-flash`, `zcodex exec`, Main PID `691158`, Sub-process `692144` `zcode-cli`, Unit `agent-task-t-bus-headless-first-use-c2932.service`)
- **Trial Bus Store**: `/home/alexey/git/agent-bus/.local/bus_headless_trial_c2932` (permissions `0700`)
- **Secret Scan Gate**: Verified clean (`SECRET_SCAN_PASS`) across all tracked files. Zero raw bearer tokens published or committed.

---

## 1. Executive Summary & Verification

Following the initial timeout and harness permission-client diagnosis in Turn 1 (Receipt `93c01a2`, Review `cd56b71`), task `t-bus-headless-first-use-c2932` was successfully resumed with:
1. Fresh scoped worker credentials (`907d0c3a-5824-42cf-befd-1e4d2cd474d5`) under mode `0600`.
2. Generous 600s execution timeout allocated by Quota Launcher.
3. Explicit instructions guiding the model to execute file output via standard shell commands (`cat << 'EOF' > ...`) rather than unconfigured interactive harness mutation tools.

A real sessionless headless agent powered by ZCode GLM-5.3-Flash completed all nine lifecycle steps autonomously without human or coordinator intervention:
- Consumed and read dispatch envelope `48ee2e24-2e9b-4608-96b6-e3bd3a06e1a7` via `bus_cli.py inbox`.
- Acknowledged dispatch on FileBus via `bus_cli.py ack` (`acked_at: 2026-10-06T18:29:17Z`).
- Accepted the task on FileBus via `bus_cli.py accept` (`accepted_at: 2026-10-06T18:29:23Z`).
- Inspected CLI help via `bus_cli.py --help` confirming 11 subcommands.
- Authored byte-exact evaluation artifact `eval_output.json` and audit report `first_use_report.json`.
- Computed SHA-256 cryptographic digests directly on disk.
- Marked task complete on FileBus via `bus_cli.py complete` (`outcome_at: 2026-10-06T18:30:12Z`).
- Dispatched reply envelope `c33bb274-8f25-4388-8b76-4a6e53bb127b` via `bus_cli.py reply` (`18:30:23Z`).
- Head read inbox and marked reply acknowledged via `bus_cli.py ack` (`acked_at: 2026-10-06T18:30:52Z`).

---

## 2. Telemetry & Execution Proof

### 2.1 Systemd Task Unit & Cgroup Allocation
```text
Unit Name:     agent-task-t-bus-headless-first-use-c2932.service
Scope Cgroup:  /user.slice/user-1000.slice/user@1000.service/app.slice/agent-task-t-bus-headless-first-use-c2932.service
Main PID:      691158 (zcodex)
Sub-process:   692144 (zcode-cli)
Command:       /home/alexey/.local/lib/zcodex/zcodex exec --model glm-5.3-flash --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false --json ...
Limits:        MemoryMax=768M, TasksMax=100
Duration:      Active ~4m 43s (CPU: ~22.4s)
```

### 2.2 Envelope Lifecycle Timeline
From `/home/alexey/git/agent-bus/.local/bus_headless_trial_c2932/messages.json`:

1. **Dispatch Message**: `48ee2e24-2e9b-4608-96b6-e3bd3a06e1a7`
   - Sender: `ee0fc438-ec10-4558-a47c-601e0d720a28` (Head)
   - Recipient: `907d0c3a-5824-42cf-befd-1e4d2cd474d5` (Worker)
   - Created At: `2026-10-06T18:23:16Z`
   - Delivered At: `2026-10-06T18:23:16Z`
   - Digest: `e313c759ef40a4a9686c2959c73af599c2310750c45dfe1c67aac9fae735ab8b`
   - Acked At: `2026-10-06T18:29:17Z`
   - Accepted At: `2026-10-06T18:29:23Z`
   - Outcome At: `2026-10-06T18:30:12Z`
   - Outcome Status: `completed`
   - Outcome Artifact: `/home/alexey/git/agent-bus/.local/bus_headless_trial_c2932/workspace/eval_output.json`
   - Outcome Digest: `65d5ee9bf4873443721f2d694db14ed94e723c7fd02a8854c7f19f0a11dda6f8`

2. **Reply Message**: `c33bb274-8f25-4388-8b76-4a6e53bb127b`
   - Sender: `907d0c3a-5824-42cf-befd-1e4d2cd474d5` (Worker)
   - Recipient: `ee0fc438-ec10-4558-a47c-601e0d720a28` (Head)
   - Reply To: `48ee2e24-2e9b-4608-96b6-e3bd3a06e1a7`
   - Body: `"Completed agent-bus CLI first use audit successfully"`
   - Created At: `2026-10-06T18:30:23Z`
   - Delivered At: `2026-10-06T18:30:23Z`
   - Digest: `8f9b1356e2bbdd8d93336b6eab7c7f9f47888d5d9059644341acd8e87870294f`
   - Head Acked At: `2026-10-06T18:30:52Z`

---

## 3. Cryptographic Artifact Verifications

1. **Evaluation Output Artifact**:
   - Path: `/home/alexey/git/agent-bus/.local/bus_headless_trial_c2932/workspace/eval_output.json`
   - Content:
     ```json
     {"status": "SUCCESS", "task_id": "t-bus-headless-first-use-c2932", "provider": "glm-5.3-flash"}
     ```
   - Disk SHA-256 Digest: `65d5ee9bf4873443721f2d694db14ed94e723c7fd02a8854c7f19f0a11dda6f8`
   - Verified: Exact bit-for-bit match with bus completion envelope outcome digest.

2. **First Use Report Artifact**:
   - Path: `/home/alexey/git/agent-bus/.local/bus_headless_trial_c2932/workspace/first_use_report.json`
   - Content:
     ```json
     {"task_id": "t-bus-headless-first-use-c2932", "message_id": "48ee2e24-2e9b-4608-96b6-e3bd3a06e1a7", "cli_inspected": true, "available_commands": ["register", "send", "inbox", "wait", "show", "ack", "accept", "complete", "reply", "queue", "flush"], "observations": "Headless sessionless bus CLI verified with scoped worker credentials on FileBus store", "status": "completed"}
     ```
   - Disk SHA-256 Digest: `172dda3290359c92a87fd14c52d9919b99ca3f8d150efb17f39089e3c3e8a953`

---

## 4. Key Takeaways & Product Intake

1. **End-to-End Headless Bus Contract Validated**:
   - Standalone `bus_cli.py` works seamlessly for sessionless headless LLM agents without an active `aplexer` session or TUI.
   - The CLI subcommands (`inbox`, `ack`, `accept`, `complete`, `reply`) operate cleanly against mode `0600` scoped worker credential files.

2. **Output Redirection in Headless Subprocesses**:
   - Model discovered that in non-interactive batch execution, redirecting CLI output to disk files (`> .out_*.txt 2>&1`) allowed seamless inspection via standard file tools, circumventing environment stdout suppression.
   - Product Intake: `codex-zcode` / `agent-quota-launcher` should configure default headless stdout streaming or native execution policies to avoid needing shell redirection workarounds.

3. **Credential Containment & Hygiene**:
   - Worker identity `907d0c3a-5824-42cf-befd-1e4d2cd474d5` was cleanly scoped and stored in mode `0600`.
   - Zero raw bearer tokens exposed in stdout, git commits, or persistent reviews.
