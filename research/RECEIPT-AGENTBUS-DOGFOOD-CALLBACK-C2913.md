# Receipt: AgentBus Inotify Completion & Refill Callback Dogfooding (Task scale50-21 / C2913)

- **Date**: 2026-10-06T17:38:49Z / 19:38 CEST
- **Product**: AgentBus (`PocketShell-io/agent-bus`) / Cross-Computer Agent Coordination
- **Target Repository**: `/home/alexey/git/agent-bus`
- **Receipt Location**: `/home/alexey/git/agent-branches/research/RECEIPT-AGENTBUS-DOGFOOD-CALLBACK-C2913.md`
- **Execution Script**: `/home/alexey/git/agent-bus/scripts/dogfood_completion_callback.py`
- **Commits**:
  - `agent-bus`: `1ceaa58` (Head completion callback engine extraction)
  - `agent-bus`: `1bd4de6` (Dogfood execution script and validation suite)
- **Actor**: `ant-head-never-timer-custody-20261006` [session `7d87f36b-8d02-4b46-8216-98d6dce3f990`]

---

## 1. Acceptance Criteria & Objective
Per Stream 2 (Task `scale50-21` / C2913):
> *"Genuine distinct head consumes own reply and starts next useful task without principal/root poke."*

Key requirements:
1. **Zero Synthetic Polling Loops**: No `time.sleep()` busy loops; event detection must be driven by native Linux kernel `inotify` syscalls (`select.poll()`).
2. **Cryptographic Outcome Integrity**: Must validate SHA-256 digest against actual on-disk artifact bytes before accepting completion.
3. **Fail-Closed Security**: Rejects tampered digests, missing files, and path traversal attempts outside authorized workspace.
4. **Durable ReadACK**: Head must acknowledge worker completion reply via `FileBus.ack()` and advance cursors.
5. **Autonomous Slot Refill**: Automatically pulls next available task from backlog and dispatches to freed worker without any external poke or human intervention.

---

## 2. Architecture & Components in `agent-bus`

The implementation resides in `coordination/completion_callback.py` in repository `agent-bus`:

| Component | Responsibility | Performance / Guarantee |
|---|---|---|
| `InotifyBusWatcher` | Blocks on Linux kernel inotify descriptor using `select.poll()` | Zero CPU usage, `sleep_poll_count == 0` |
| `DigestValidator` | Verifies outcome payload: status `ok`, artifact path, SHA-256 checksum | Rejects bit-flips, missing files, and path traversal |
| `HeadTaskBacklog` | Thread-safe task state tracking (`pending`, `dispatched`, `completed`, `failed`) | Strict deterministic FIFO prioritization |
| `HeadCompletionCallbackEngine` | Orchestrates dispatch, inotify wait, digest verification, readACK, and refill | Zero external pokes (`external_poke_count == 0`) |

---

## 3. Empirical Dogfood Execution Evidence

The dogfood script `/home/alexey/git/agent-bus/scripts/dogfood_completion_callback.py` was executed directly:

```bash
$ python3 /home/alexey/git/agent-bus/scripts/dogfood_completion_callback.py
```

### Execution Output & Verification Results:
```json
{
  "test_status": "SUCCESS",
  "timestamp_utc": "2026-10-06T17:38:49Z",
  "tasks_dispatched": 3,
  "tasks_completed": 3,
  "refill_count": 2,
  "synthetic_sleep_count": 0,
  "external_poke_count": 0,
  "watcher_kernel_event_count": 6,
  "watcher_sleep_poll_count": 0,
  "worker_records": [
    {
      "task_id": "task-batch-1",
      "artifact": "/tmp/dogfood_callback_hm9w16cx/workspace/artifact_task-batch-1.json",
      "digest": "c3df51455f363989718ead4fc5bac8aa5f22739669b102887c8c7af508852027"
    },
    {
      "task_id": "task-batch-2",
      "artifact": "/tmp/dogfood_callback_hm9w16cx/workspace/artifact_task-batch-2.json",
      "digest": "685d73e936ffba70dd31c940278f42e24cd958e0d5ace41e3806151d00cb7635"
    },
    {
      "task_id": "task-batch-3",
      "artifact": "/tmp/dogfood_callback_hm9w16cx/workspace/artifact_task-batch-3.json",
      "digest": "8de217394d26251115964e2f51af56f81b3c0ebf6d691dbdb7ef7fdb4aa4caea"
    }
  ],
  "audit_log_events": 8,
  "negative_cases_verified": {
    "tampered_digest_rejected": true,
    "tampered_reason": "digest_mismatch:reported=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff,actual=bd80fc79eb35b6fa443d0b1103361b3a2ecd0772e83e03ac4f97544fabcf9466",
    "path_traversal_rejected": true,
    "path_traversal_reason": "path_traversal_outside_workspace:/tmp/dogfood_callback_hm9w16cx/outside_secret.json"
  }
}
```

---

## 4. Verification Summary
1. **Autonomous Refill**: Worker slot refilled sequentially for all 3 tasks (`refill_count == 2` for a single worker slot).
2. **Zero Polling Loops**: `synthetic_sleep_count == 0` and `watcher_sleep_poll_count == 0`.
3. **Zero External Pokes**: `external_poke_count == 0`.
4. **Kernel Event Trigger**: Inotify watcher recorded 6 kernel events (`watcher_kernel_event_count == 6`).
5. **Negative Test Safety**:
   - Bit-flipped digest rejected fail-closed with `digest_mismatch`.
   - Artifact path outside workspace rejected fail-closed with `path_traversal_outside_workspace`.

Status: **COMPLETED AND VERIFIED**. Ready for independent review.
