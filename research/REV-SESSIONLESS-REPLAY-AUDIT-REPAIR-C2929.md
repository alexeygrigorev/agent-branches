# Independent Review: Idempotent Replay & Audit Repair in Sessionless Model Callback (C2929)

- **Reviewer**: Independent Code & Architecture Reviewer (Antigravity Subagent)
- **Reviewer Conversation ID**: `0c24be74-732e-43cc-a7ec-b15d4b4976d6`
- **Caller Agent ID**: `ea14b401-20e9-4e48-ab08-d15be08da30d`
- **Target Commit**: `f6fdf6bb377dd60a9920e847984d2d55b73a48c5` (`f6fdf6b`) in `/home/alexey/git/agent-bus`
- **Author of Fix**: `715e20c8-331b-4601-886a-8ea43ba18e8f` (implementer)
- **Audited File**: [`scripts/run_sessionless_model_callback.py`](file:///home/alexey/git/agent-bus/scripts/run_sessionless_model_callback.py)
- **Date**: 2026-10-06T17:55:00Z / 19:55 CEST
- **Shared Repository Contention**: Verified zero new dirty edits in `/home/alexey/git/cloudflare-agent-git` (`git status --porcelain` contains no changes from this review task).
- **Final Verdict**: **ACCEPTED** (Unconstrained)

---

## 1. Executive Summary & Review Scope

Following Codex Principal instructions for Task C2929, this independent review rigorously audited commit `f6fdf6bb377dd60a9920e847984d2d55b73a48c5` in `agent-bus`, authored by `715e20c8-331b-4601-886a-8ea43ba18e8f`.

### Problem Statement & Context
In `scripts/run_sessionless_model_callback.py`, `cmd_head_consume` is responsible for reading worker completion replies from the Head identity's inbox, cryptographically validating the SHA-256 digest of the produced disk artifact via `DigestValidator.validate_outcome`, issuing a durable `bus.ack()`, and marking the corresponding task as completed.

Prior to commit `f6fdf6b`, `cmd_head_consume` queried the inbox strictly with `unread_only=True`:
```python
inbox = bus.inbox(head_ident.identity_id, head_tok, unread_only=True)
```
While this correctly consumes replies during first-time execution, it created a severe operational limitation for independent verification and auditing:
- Upon initial successful consumption, `bus.ack()` marks the reply message with `acked_at: "<timestamp>"`.
- When an independent auditor, automated regression check, or replay harness subsequently executes `run_sessionless_model_callback.py --mode head-consume`, `bus.inbox(..., unread_only=True)` returns an empty list `[]`.
- Consequently, `consumed_replies` returned `0` and `task_completed` returned `False`, falsely indicating that the task was uncompleted or that no replies existed, despite valid completion replies existing in the bus store.

### The Repair in Commit `f6fdf6b`
Commit `f6fdf6b` introduced an idempotent fallback:
```python
# Process unread replies in head inbox (fall back to all replies for idempotent replay/audit)
inbox = bus.inbox(head_ident.identity_id, head_tok, unread_only=True)
if not inbox:
    inbox = bus.inbox(head_ident.identity_id, head_tok, unread_only=False)
```

This review verified:
1. Semantic intent and architectural correctness of the fallback.
2. Safety and idempotency of subsequent `bus.ack()` calls on already-acknowledged messages.
3. Negative edge cases and fail-closed behaviors (empty inbox, tampered digest, invalid credentials, missing artifact, path traversal outside workspace).
4. Full test suite execution across `agent-bus` (all 42 unit and integration tests passing).
5. Zero contention with ongoing tasks in `/home/alexey/git/cloudflare-agent-git`.

---

## 2. Code Verification & Diff Analysis

### 2.1 Git Diff Analysis
Target commit `f6fdf6bb377dd60a9920e847984d2d55b73a48c5`:
```diff
diff --git a/scripts/run_sessionless_model_callback.py b/scripts/run_sessionless_model_callback.py
index acb1323..6d7b7ac 100644
--- a/scripts/run_sessionless_model_callback.py
+++ b/scripts/run_sessionless_model_callback.py
@@ -211,8 +211,10 @@ def cmd_head_consume(bus_dir: Path, ws_dir: Path) -> dict[str, Any]:
 
     # Read pending dispatch mapping from bus messages
     all_msgs = bus.read_all() if hasattr(bus, "read_all") else []
-    # Process unread replies in head inbox
+    # Process unread replies in head inbox (fall back to all replies for idempotent replay/audit)
     inbox = bus.inbox(head_ident.identity_id, head_tok, unread_only=True)
+    if not inbox:
+        inbox = bus.inbox(head_ident.identity_id, head_tok, unread_only=False)
     consumed_count = 0
     validation_results = []
```

### 2.2 Semantic Correctness & Safe Idempotency
An in-depth inspection of `coordination/bus.py` confirms that `FileBus.ack()` and `FileBus.inbox()` are explicitly designed for safe idempotent operation:

1. **Inbox Filtering (`coordination/bus.py:344-345`)**:
   ```python
   if unread_only and raw.get("acked_at"):
       continue
   out.append(_msg(raw))
   ```
   When `unread_only=True`, messages with `acked_at` set are skipped. When `unread_only=False`, all messages addressed to the authenticated identity within the project are returned, sorted chronologically (`out.sort(key=lambda m: m.created_at)`).

2. **Durable ACK Idempotency (`coordination/bus.py:387-388`)**:
   In `FileBus._touch_locked()`:
   ```python
   if type(raw.get(field)) is str:
       return _msg(raw)
   ```
   If a message has already been acknowledged (`acked_at` is a string timestamp), re-invoking `bus.ack()` is an idempotent no-op: it immediately returns the existing message without modifying timestamps, without acquiring write modifications, and without corrupting state.

3. **Validation Enforcement in `cmd_head_consume`**:
   The fallback loop processes replies:
   ```python
   for msg in inbox:
       if msg.kind == "reply":
           orig_msg_id = msg.reply_to
           outcome = msg.data or {}
           is_valid, err, computed = DigestValidator.validate_outcome(outcome, workspace_root=ws_dir)
           validation_results.append({
               "message_id": msg.message_id,
               "reply_to": orig_msg_id,
               "is_valid": is_valid,
               "error": err,
               "digest": computed,
           })
           if is_valid:
               bus.ack(head_ident.identity_id, head_tok, msg.message_id)
               task.status = "completed"
               task.outcome = outcome
               task.outcome_digest = computed
               consumed_count += 1
   ```
   Critically:
   - Only messages of kind `"reply"` are validated.
   - Every reply must independently pass cryptographic SHA-256 validation against the actual disk artifact via `DigestValidator.validate_outcome()`.
   - Replay/audit recalculates the SHA-256 digest of the file currently on disk. If the artifact has been corrupted or deleted since initial consumption, validation fails closed (`is_valid: False`).

---

## 3. Empirical Test Results & Verification Scenarios

An automated test suite was constructed and executed to verify both positive replay semantics and negative fail-closed behavior.

### 3.1 Scenario 1: Fresh Pipeline Execution (Unread Path)
- `cmd_head_init`: Head and worker registered, task `t-sessionless-eval-c2925` dispatched (`dispatched_count: 1`).
- `cmd_worker_exec`: Worker consumes dispatch, creates on-disk artifact `eval_output.json`, generates SHA-256 digest, sends reply envelope.
- `cmd_head_consume` (first run):
  - Fetches inbox with `unread_only=True`.
  - Finds 1 unread reply.
  - Validates digest (`is_valid: True`).
  - ACKs reply.
  - Returns `consumed_replies: 1`, `task_completed: True`.

### 3.2 Scenario 2: Idempotent Replay / Post-Hoc Audit (Acked Fallback Path)
- Immediately re-invoked `cmd_head_consume` on the same bus store without any worker re-execution.
- `inbox(..., unread_only=True)` returned `[]`.
- Fallback triggered: `inbox(..., unread_only=False)` returned the previously acked reply.
- `DigestValidator.validate_outcome` recomputed SHA-256 from disk bytes, verified match against envelope digest.
- `bus.ack()` safely returned without modifying timestamps.
- Returns `consumed_replies: 1`, `task_completed: True`.
- **Result: PASS. Audit/replay is fully idempotent.**

---

## 4. Rigorous Negative Testing & Fail-Closed Behavior

To ensure the fallback does not bypass security or validation boundaries, five negative test cases were executed:

### Negative Test 1: Empty Inbox (No Messages / Unreplied Task)
- **Setup**: `cmd_head_init` executed, but `cmd_worker_exec` never run.
- **Execution**: `cmd_head_consume` called on store where Head has received no replies.
- **Behavior**:
  - `unread_only=True` returns `[]`.
  - Fallback `unread_only=False` returns `[]`.
  - `consumed_replies`: `0`, `task_completed`: `False`, `validation_results`: `[]`.
- **Verdict: PASS (Fails closed cleanly).**

### Negative Test 2: Tampered Digest (Bit-Flip on Disk Artifact)
- **Setup**: Valid pipeline executed up to worker reply. The artifact file `eval_output.json` was then tampered with ("TAMPERED CONTENT BITFLIP").
- **Execution**: `cmd_head_consume` executed against the tampered workspace.
- **Behavior**:
  - `DigestValidator.validate_outcome()` detected digest mismatch:
    `digest_mismatch:reported=6e04cdfd...,actual=a5c091b9...`
  - `is_valid`: `False`.
  - `bus.ack()` was **NOT** invoked.
  - `task.status` was **NOT** transitioned to `completed`.
  - `consumed_replies`: `0`, `task_completed`: `False`.
- **Verdict: PASS (Fails closed against payload tampering).**

### Negative Test 3: Invalid Authentication Token
- **Setup**: The bearer token in `head.cred.json` was corrupted with an unauthorized random string.
- **Execution**: `cmd_head_consume` executed.
- **Behavior**:
  - `FileBus._auth_locked()` rejected the token immediately, raising `coordination.bus.BusError: auth_failed:<identity_id>`.
  - Zero messages read, zero state changes.
- **Verdict: PASS (Fails closed on unauthenticated access).**

### Negative Test 4: Missing Artifact File
- **Setup**: Worker produced reply, but artifact `eval_output.json` was deleted from disk prior to consume.
- **Execution**: `cmd_head_consume` executed.
- **Behavior**:
  - `DigestValidator.validate_outcome()` detected missing file:
    `artifact_not_found:.../eval_output.json`
  - `is_valid`: `False`, `consumed_replies`: `0`, `task_completed`: `False`.
- **Verdict: PASS (Fails closed against missing filesystem artifacts).**

### Negative Test 5: Path Traversal Outside Workspace Root
- **Setup**: A reply message was tampered to point to an artifact located outside the permitted `workspace_root` directory.
- **Execution**: `cmd_head_consume` executed.
- **Behavior**:
  - `DigestValidator.validate_outcome()` detected traversal:
    `path_traversal_outside_workspace:.../outside.json`
  - `is_valid`: `False`, `consumed_replies`: `0`, `task_completed`: `False`.
- **Verdict: PASS (Fails closed against sandbox breakout).**

---

## 5. Test Suite Execution (`agent-bus`)

The full regression test suite of `agent-bus` was executed in the test environment:
```bash
PYTHONPATH=/home/alexey/git/agent-bus pytest -v /home/alexey/git/agent-bus/tests/
```

### Pytest Run Summary:
```
============================= test session starts ==============================
platform linux -- Python 3.12.3, pytest-9.1.1, pluggy-1.6.0
rootdir: /home/alexey/git/agent-bus
configfile: pyproject.toml
plugins: anyio-4.12.1, opik-2.2.54
collecting ... collected 42 items

../agent-bus/tests/test_bus.py ...........                               [ 26%]
../agent-bus/tests/test_bus_concurrent.py ..                             [ 30%]
../agent-bus/tests/test_bus_crash.py .....                               [ 42%]
../agent-bus/tests/test_bus_dogfood.py .                                 [ 45%]
../agent-bus/tests/test_bus_scope.py ....                                [ 54%]
../agent-bus/tests/test_completion_callback.py ...                       [ 61%]
../agent-bus/tests/test_headless_task.py .                               [ 64%]
../agent-bus/tests/test_ql_task_unit_adapter.py ............             [ 92%]
../agent-bus/tests/test_worker_bus.py ...                                [100%]

============================== 42 passed in 8.43s ==============================
```
- Total test items: 42
- Passed: 42
- Failed: 0
- Execution time: 8.43 seconds

---

## 6. Zero Contention Verification

A clean working directory check was performed in the shared repository `/home/alexey/git/cloudflare-agent-git`:
```bash
git -C /home/alexey/git/cloudflare-agent-git status --porcelain
```
Result verified: No files in `/home/alexey/git/cloudflare-agent-git` were modified, created, or touched by this review. Zero contention maintained.

---

## 7. Review Verdict & Recommendations

### Final Verdict: **ACCEPTED** (Unconstrained)

### Summary of Findings:
1. **Target Commit**: `f6fdf6bb377dd60a9920e847984d2d55b73a48c5` in `agent-bus` is minimal (3 inserted lines, 1 deleted line), elegant, and solves the exact replay audit bug without unintended side-effects.
2. **Idempotent Safety**: Validated that `bus.ack()` in `FileBus` is strictly idempotent and that `DigestValidator` validates disk bytes dynamically on every consume call.
3. **Negative Tests**: All 5 negative boundary test cases (empty inbox, digest bit-flip, invalid auth token, missing artifact, path traversal) correctly fail closed.
4. **Regression Free**: All 42 tests across `agent-bus` pass without issue.
