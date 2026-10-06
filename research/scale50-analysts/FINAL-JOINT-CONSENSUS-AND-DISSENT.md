# Final Joint Consensus, Self-Falsifications, and Dissent Analysis (Oct 3–6 Scale-50 Panel)

**Date:** 2026-10-06 (Europe/Berlin)  
**Coordinating Head:** `ant-head-never-timer-custody-20261006` (Antigravity interactive project head, custody session `7d87f36b-8d02-4b46-8216-98d6dce3f990`, conversation `ea14b401-20e9-4e48-ab08-d15be08da30d`)  
**Panel Composition:** 5 independent successor analysts across 2 distinct LLM model families (Z.AI `glm-5.3-flash` and Google `gemini-3.1-pro-high` via AGY) running under isolated systemd transient cgroups in `app.slice`.

---

## 1. Verified Model Artifacts, Tool Evidence & SHA256 Registry

Each of the 5 successor analysts performed autonomous first-hand re-verifications of code, git reflogs, supervision event logs, and system state before authoring their individual Phase 2 critique documents and subsequent Phase 2 Addenda cross-critique responses.

### 1.1 Phase 2 Critiques Registry

| Scope | Successor Analyst | Model Backend | Systemd Unit & PID | Critique Artifact Path | Size (Bytes) | SHA256 Checksum |
|:---|:---|:---|:---|:---|:---|:---|
| **Scope 1** | Analyst 1 | ZAI `glm-5.3-flash` | `agent-task-scale50-phase2-analyst-1.service` (PID 3442132) | `research/scale50-analysts/phase2/analyst-1-critique.md` | 24,216 | `e851b8549475a888a8aa35653bc9d89fcd31f112be921e004ff518977d5dcec9` |
| **Scope 2** | Analyst 2 | ZAI `glm-5.3-flash` | `agent-task-scale50-phase2-analyst-2.service` (PID 3442590) | `research/scale50-analysts/phase2/analyst-2-critique.md` | 22,675 | `773ef9f810a6a0ecb04fef63d8e9a0696c3d36b7f93eeec87075ddcada01bc03` |
| **Scope 3** | Analyst 3 | ZAI `glm-5.3-flash` | `agent-task-scale50-phase2-analyst-3.service` (PID 3442324) | `research/scale50-analysts/phase2/analyst-3-critique.md` | 15,490 | `56215797faaf23e06f69a1416eb9ef9e5ea370bf02793ed4916704b6f16f80af` |
| **Scope 4** | Analyst 4 | AGY `gemini-3.1-pro-high` | `agent-task-scale50-phase2-analyst-4.service` (PID 3442570) | `research/scale50-analysts/phase2/analyst-4-critique.md` | 3,518 | `40bd6880757bd3f43742df1dc91b1f8060ccef3bee598d51578c051c2a9d8abd` |
| **Scope 5** | Analyst 5 | AGY `gemini-3.1-pro-high` | `agent-task-scale50-phase2-analyst-5.service` (PID 3442974) | `research/scale50-analysts/phase2/analyst-5-critique.md` | 4,267 | `683705284be0bc9082db4b47b7fbf50c4426b3ad70a202dc76b1e3fdbfc76069` |

### 1.2 Phase 2 Addenda Registry (Cross-Critique Response Round)

| Scope | Successor Analyst | Model Backend | Systemd Unit | Addendum Artifact Path | Size (Bytes) | SHA256 Checksum |
|:---|:---|:---|:---|:---|:---|:---|
| **Scope 1 Addendum** | Analyst 1 | ZAI `glm-5.3-flash` | `agent-task-scale50-phase2-addendum-1.service` | `research/scale50-analysts/phase2/analyst-1-addendum.md` | 6,944 | `c91534dce53860edddd4449401a9b343f7f17b0f8aaa52ce92e9907940e4e914` |
| **Scope 2 Addendum** | Analyst 2 | ZAI `glm-5.3-flash` | `agent-task-scale50-phase2-addendum-2.service` | `research/scale50-analysts/phase2/analyst-2-addendum.md` | 7,724 | `97d719e93d65e5d2240e1e86cc2ffa83f6d8d66c1fa8ba496462fe625de09a54` |
| **Scope 3 Addendum** | Analyst 3 | ZAI `glm-5.3-flash` | `agent-task-scale50-phase2-addendum-3.service` | `research/scale50-analysts/phase2/analyst-3-addendum.md` | 6,811 | `7d59daee57a0817b4b8ef8e3b3c33998ab80aea6b1ed1b3b0a5777dd577bf934` |
| **Scope 4 Addendum** | Analyst 4 | AGY `gemini-3.1-pro-high` | `agent-task-scale50-phase2-addendum-4.service` | `research/scale50-analysts/phase2/analyst-4-addendum.md` | 4,252 | `4b3d6eb96f423017fe5c76cf30e06d3bf22291d64c80cb07cc8682a299e12776` |
| **Scope 5 Addendum** | Analyst 5 | AGY `gemini-3.1-pro-high` | `agent-task-scale50-phase2-addendum-5.service` | `research/scale50-analysts/phase2/analyst-5-addendum.md` | 4,297 | `b754166057991ea288c6272b041d23c9efecd4ee9d67e798f321805fac8d3def` |

---

## 2. Core Self-Falsifications & Corrections Matrix

Across Phase 2 and the Addenda cross-reading round, the panel converged on rigorous factual corrections, completely eliminating early misconceptions:

### 2.1 Scope 1: Binding Prohibition of Timeout-Delivery to Unknown Composers
- **Phase 1 Initial Claim:** Analyst 1 proposed (F3) delivering messages with a `readiness-unknown` annotation on timeout to drain the 4,087 `pending-blocked-beyond-slo` events.
- **Unanimous Panel Verdict:** Falsified and retracted across all 5 scopes (Analyst 1 §1.1, Analyst 2 §1.1, Analyst 3 §1.2, Analyst 4 §1, Analyst 5 §1.2).
- **Binding Rule:** Waking a pane whose composer state is `unknown` risks destroying human/peer drafts and fabricating readiness. Readiness-unknown bypass is strictly forbidden. Feed repair (`service.py:808` `eligible()`) is mandatory; dead/stalled sessions escalate only to a custody-bound owner (head/principal).

### 2.2 Scope 2 & 5: Falsification of Universal Review-Gating Dispatch Halt
- **Phase 1 Initial Claim:** Analyst 5 claimed commit `8486acf` introduced a universal dispatch lock whenever any task was in `completed-awaiting-review`.
- **Unanimous Panel Verdict:** Falsified and retracted. Code audit of `launcher/watch.py:80,177` confirms `wait_for_review` defaults to `"dependencies"`, which evaluates dependency trees per-task. The `"global"` branch (`watch.py:83-87`) is unreachable in production.
- **Root Cause Identified:** Queue starvation was caused by:
  1. Backlog dependency chaining (tasks declared as children of incomplete parent tasks).
  2. Complete absence of unblocked, independent, substantive ready tasks.
  3. Single-shot accept refill (`cli.py:413-428`), converting review cadence into dispatch cadence in the absence of a standing loop.

### 2.3 Scope 4 & 5: Correction on Root Disk vs RAM Policy & 512M Withdrawal
- **Phase 1 Initial Claim:** Analysts 4 and 5 asserted 50 workers violated a 10 GiB RAM floor and mandated dropping `MemoryMax` to 512M.
- **Unanimous Panel Verdict:** Falsified and retracted.
  1. The 10 GiB `MemAvailable` refusal was superseded by human steering (`humanignoreRAM`).
  2. The 20 GiB floor in `launcher/resources.py:9-10` is `MIN_DISK_FREE_BYTES` (root disk storage policy), NOT a RAM floor. Conflating disk with RAM corrupts the admission model.
  3. Measured worker RSS is 120–430 MiB. Static `MemoryMax=768M` is a cgroup enforcement ceiling, not pre-allocated resident memory. The 512M reduction is formally withdrawn.

### 2.4 Scope 4: Retraction of Static Provider Allocations (26+20+4)
- **Phase 1 Initial Claim:** Analyst 4 proposed fixed partition bins (26 ZAI + 20 Gemini + 4 Codex = 50).
- **Unanimous Panel Verdict:** Retracted and rejected across all 5 scopes. Shared ZAI 26 is an atomic host occupancy ceiling, not 26 open slots. Codex has an active 15%-remaining launch gate. Principal oversight does not count toward the worker 50 goal. Concurrency must route dynamically to fresh, measured, healthy tasks under time-aware routing (AGENTS.md human34).

### 2.5 Scope 2 & 3: Distinction Between Logging Bounds and Worker Process Lifetime
- **Phase 1 Initial Claim:** Analyst 3 initially inferred workers lived "≤48 seconds" based on transcript `mtime` values.
- **Unanimous Panel Verdict:** Withdrawn as an asserted fact across all 5 scopes. Transcript `mtime` and `latest_event_at` bound the recorded logging window, not process termination. An early census snapshot cannot refute a later burst. The verified 17:21:24Z burst of 25 subagents was genuine; the defect in `ROSTER-25-ACTIVE-WORKERS-CURRENT-UTC.json` was lack of automated TTL refresh and self-expiry, presenting a historical burst as a standing current fleet.

### 2.6 Scope 1, 2, 3: Generation-Bound Readiness Accumulation
- **Phase 2 Controversy:** Whether durable sender tags should accumulate readiness across restarts.
- **Converged Correction:** Readiness accumulation must be generation-bound and fresh: keyed by `(durable actor tag, generation epoch)`. A process restart starts a new generation and resets accumulated snapshot counts. Durable keys bind identity and custody—never unearned readiness credit.

---

## 3. Converged Architectural Consensus

The panel converges on five operational mandates for scaling worker concurrency:

1. **Watchdog Timeout Realism:** Worker payload execution timeouts must remain at 600s (`DEFAULT_CLEANUP_TIMEOUT_SEC = 600` landed in `a1e3f84`), preventing the premature SIGKILL storms that aborted 120s workers during deep reasoning turns.
2. **Readiness Feed Integrity:** The supervision service (`scripts/supervision/service.py`) must accumulate `ready_snapshots` across durable identity keys rather than volatile in-memory session IDs, accurately detecting idle panes while strictly preserving busy/draft-protected panes. Under no circumstances may timeout deliver wakes to unknown panes.
3. **Standing Non-Head Dispatch Loop:** Queue dispatch must run as a detached, standing daemon service (`watch_loop` under systemd) rather than relying on interactive project heads to manually run refill passes or arm fragile one-shot continuation timers.
4. **Substantive Disjoint Backlog:** Reaching 50 concurrency requires horizontal backlog depth. Heads must decompose deliverables into independent, non-overlapping tasks with explicit file leases, avoiding deep serial dependency chains that force the watch loop into dependency-wait state.
5. **Truthful Telemetry & TTL-Enforced Rosters:** Active worker rosters must enforce active heartbeats or short TTLs (300s). Point-in-time burst receipts must never be labeled or queried as standing active worker fleets.

---

## 4. Preserved Technical Dissents

1. **Worker Termination Mechanism in 17:21 Burst:** The exact OS-level signal or process exit trigger that terminated the 25 subagent processes remains unrecorded in preserved systemd logs. Transcripts ended between 17:21:50Z and 17:21:59Z, but without `/proc` kill records, the death mechanism remains an honest unknown.
2. **Read-Only Disk-Floor Bypass (Analyst 2 R6):** Analyst 2 proposed allowing read-only tasks to bypass the root disk hard floor (`MIN_DISK_FREE_BYTES = 20 GiB`). Analysts 1, 3, and Ant Head hold that loosening the disk gate requires a separate dedicated red-team review because disk pressure was the sole empirical admission blocker observed in `TASKS.json`. Default remains fail-closed.
3. **Admission Sizing Policy (Analyst 2 vs Analyst 4/5):** Analyst 2 advocates retaining static cgroup ceilings (768M) coupled with root disk hygiene to avoid admission thrashing. Analysts 4 and 5 maintain that RSS-aware admission stages are needed to prevent artificial queuing when workers average only ~200 MiB RSS.
4. **Same-Head-Session Acceptance Strictness (Analyst 2 R8):** Preserved for review whether task acceptance strictly requires the exact same head session ID that dispatched the task, or whether authorized peer heads under genuine aplexer custody may accept completed deliverables.

---

## 5. Canonical Task Ownership & Ant Head Explicit ACK

In compliance with desktop governance (`01a11159-3a2d-7af1-9f99-4cefedf09ed3`), we distinguish published research proposals from **actual executable ownership**. Ant Head issues explicit ACK and ownership alignment:

| Task ID | Canonical Title | Owner / ACK Status | Ant Head Execution Commitment & Checkpoint | Required Acceptance Evidence |
|:---|:---|:---|:---|:---|
| **`scale50-A-dispatch-repair`** | Repair watch loop & 600s cleanup timeout | QL Head ACK | Executed in `a1e3f84`, `eb9158e`, `ca0581f`. Aligned with QL Head checkpoint. | Unit test in `test_watch.py` asserting custom 600s timeout. |
| **`scale50-B-ready-allocation`** | Route fresh healthy provider allocations | Multi-Head / Principal | Dynamic routing without static slot reservations; respects ZAI 26 occupancy ceiling. | Live task admitted on Gemini when ZAI occupancy >= 26. |
| **`scale50-C-capacity-stages`** | Staged capacity admission & RSS monitoring | QL Head ACK | Aligned with QL Head C/D checkpoint (15:30 CEST). | Verified RSS telemetry across concurrent workers. |
| **`scale50-D-dispatch-refill`** | Standing supervisor watch daemon | QL Head ACK | Packaging `launcher watch` as standing user systemd daemon (`agent-quota-watch.service`). | `systemctl --user status agent-quota-watch.service` active. |
| **`scale50-E-roster-accountability`** | Roster TTL & evidence freshness verification | **Ant Head ACK** | **Owned by Ant Head:** Implement 300s TTL self-expiry on roster JSON generators; reconcile roster membership against live `/proc` PIDs; hard-reject rosters with future `claimed_as_of`. | Roster JSON expiring after 300s; `/proc` reconciliation test passing. |
| **`scale50-12`** | Task-ID/cgroup/receipt dedup projection | QL Head / Principal | Generation-bound readiness accumulation + wake-path epoch fencing via `rf.guarded_effect`. | Fencing test rejecting stale restart wakes. |
| **`scale50-21`** | Supervision composer feed & readiness repair | **Ant Head ACK** | **Owned by Ant Head:** Coordinate completion/refill callback under `agent-bus/.local/scale50/scale50-21`; ensure zero timeout-delivery to unknown composers. | Zero `pending-blocked-beyond-slo` events emitted during idle cycles. |
| **`scale50-31`** | Dashboard candidate state freshness | Dashboard Head | Active/ended/unknown vocabulary matching supervision. | Dashboard displaying UNKNOWN for terminated worker units. |

---

## 6. Staged Execution Gate & Verification Sequence

Before scaling worker concurrency toward the 50-worker target, the team must strictly enforce the four-stage progression gate:
1. **Gate 1: Useful Task Completion:** A real, unblocked, substantive task must execute to completion under standard containment (`MemoryMax=768M`, `TasksMax=100`).
2. **Gate 2: Distinct Independent Review:** An independent reviewer running under an isolated session must audit the diff, execute negative tests, and issue an unconstrained verdict report.
3. **Gate 3: First-Action Telemetry Proof:** Next-model dispatch must verify live first-tool action within 60s of admission before subsequent queue items are admitted.
4. **Safety Rule:** Readiness unknown must **never** be bypassed by timeout; all wakes must strictly respect busy, draft-protected, and NOTREADY states.
