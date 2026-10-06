# Final Joint Consensus, Self-Falsifications, and Dissent Analysis (Oct 3–6 Scale-50 Panel)

**Date:** 2026-10-06 (Europe/Berlin)  
**Coordinating Head:** `ant-head-never-timer-custody-20261006` (Antigravity interactive project head, custody session `7d87f36b-8d02-4b46-8216-98d6dce3f990`, conversation `ea14b401-20e9-4e48-ab08-d15be08da30d`)  
**Panel Composition:** 5 independent successor analysts across 2 distinct LLM model families (Z.AI `glm-5.3-flash` and Google `gemini-3.1-pro-high` via AGY) running under isolated systemd transient cgroups in `app.slice`.

---

## 1. Verified Model Artifacts, Tool Evidence & SHA256 Registry

Each of the 5 successor analysts performed autonomous first-hand re-verifications of code, git reflogs, supervision event logs, and system state before authoring their individual Phase 2 critique documents.

| Scope | Successor Analyst | Model Backend | Systemd Unit & PID | Critique Artifact Path | Size (Bytes) | SHA256 Checksum |
|:---|:---|:---|:---|:---|:---|:---|
| **Scope 1** | Analyst 1 | ZAI `glm-5.3-flash` | `agent-task-scale50-phase2-analyst-1.service` (PID 3442132) | `research/scale50-analysts/phase2/analyst-1-critique.md` | 24,216 | `e851b8549475a888a8aa35653bc9d89fcd31f112be921e004ff518977d5dcec9` |
| **Scope 2** | Analyst 2 | ZAI `glm-5.3-flash` | `agent-task-scale50-phase2-analyst-2.service` (PID 3442590) | `research/scale50-analysts/phase2/analyst-2-critique.md` | 22,675 | `773ef9f810a6a0ecb04fef63d8e9a0696c3d36b7f93eeec87075ddcada01bc03` |
| **Scope 3** | Analyst 3 | ZAI `glm-5.3-flash` | `agent-task-scale50-phase2-analyst-3.service` (PID 3442324) | `research/scale50-analysts/phase2/analyst-3-critique.md` | 15,490 | `56215797faaf23e06f69a1416eb9ef9e5ea370bf02793ed4916704b6f16f80af` |
| **Scope 4** | Analyst 4 | AGY `gemini-3.1-pro-high` | `agent-task-scale50-phase2-analyst-4.service` (PID 3442570) | `research/scale50-analysts/phase2/analyst-4-critique.md` | 3,518 | `40bd6880757bd3f43742df1dc91b1f8060ccef3bee598d51578c051c2a9d8abd` |
| **Scope 5** | Analyst 5 | AGY `gemini-3.1-pro-high` | `agent-task-scale50-phase2-analyst-5.service` (PID 3442974) | `research/scale50-analysts/phase2/analyst-5-critique.md` | 4,267 | `683705284be0bc9082db4b47b7fbf50c4426b3ad70a202dc76b1e3fdbfc76069` |

### Per-Model Tool & Writing Execution Trace
- **Analyst 1 (Scope 1, PID 3442132):** Used bash commands via `zcodex` tool router. Audited `launcher/watch.py`, `service.py`, `resources.py`, and reflogs. Verified cleanup timeout relaxed to 600s in commit `a1e3f84` (noting cross-reading discrepancy from `eb9158e`). Wrote 24K critique via bash heredoc after verifying all claims.
- **Analyst 2 (Scope 2, PID 3442590):** Recovered the full Scope 2 analysis previously truncated in Phase 1 due to `No permission client configured for Write/Bash`. In Phase 2, executed bash reads and probed writes with `.write-test`. Verified that `watch.py:83-87` global halt only exists under test flag `wait_for_review == "global"`, whereas production default is `wait_for_review="dependencies"`. Authored 22K complete critique via bash heredoc.
- **Analyst 3 (Scope 3, PID 3442324):** Re-verified byte identity between `.local/scale50/ROSTER-25-ACTIVE-WORKERS-20261005.json` and `.local/scale50/ROSTER-25-ACTIVE-WORKERS-CURRENT-UTC.json`. Re-queried `events.jsonl` confirming `pending-blocked-beyond-slo` grew to 4,097 events with `ready_snapshots: 0`. Authored 15K critique via bash heredoc.
- **Analyst 4 (Scope 4, PID 3442570):** Ran under native Antigravity runtime. Audited resource policy and provider quotas. Produced 3.5K critique withdrawing 512M recommendation and clarifying multi-provider routing.
- **Analyst 5 (Scope 5, PID 3442974):** Ran under native Antigravity runtime. Audited `watch.py` commit `8486acf` and cgroup memory properties. Produced 4.2K critique withdrawing total dispatch halt claim.

---

## 2. Core Self-Falsifications & Corrections

Across Phase 2, the panel explicitly falsified several initial Phase 1 hypotheses through rigorous cross-examination:

### 2.1 Scope 1: Retraction of Timeout-Delivery for Blocked Messages
- **Phase 1 Claim:** Analyst 1 initially proposed (F3) delivering messages with a `readiness-unknown` annotation after SLO timeout to relieve the 4,087 `pending-blocked-beyond-slo` backlog.
- **Phase 2 Falsification & Retraction:** Analyst 1 explicitly retracted this proposal. Waking a pane whose composer state is `unknown` risks interrupting active drafts or busy sessions, in direct violation of AGENTS.md ("never invent readiness", "never interrupt a busy pane"). Timeout of a sender's SLO is zero evidence of recipient readiness. The correct remedy is repairing the upstream composer readiness feed (`ready_snapshots`) and escalating unresolvable dead-session blocks to the owning head/principal, never delivering blind.

### 2.2 Scope 2 & 5: Falsification of the Universal Review-Gating Dispatch Halt
- **Phase 1 Claim:** Analyst 5 claimed commit `8486acf` introduced a global gate that halted all queue refill whenever any single task was in `completed-awaiting-review`.
- **Phase 2 Falsification & Correction:** First-hand audit of `launcher/watch.py` (lines 83–89, 177) proved that `wait_for_review` defaults to `"dependencies"` (or `True`), which evaluates dependency chains per-task. Global halt (`wait_for_review == "global"`) is only exercised in unit tests (`test_watch.py:55`). Disjoint/independent tasks dispatch freely. The observed starvation occurred because the backlog chained tasks in serial dependency sequences and lacked independent, unblocked, substantive, owner-ACKed tasks.

### 2.3 Scope 4 & 5: Falsification of Mathematical RAM Exhaustion and 512M Reduction
- **Phase 1 Claim:** Analysts 4 and 5 asserted that 50 workers at `MemoryMax=768M` mathematically required 38.4 GiB, violating a 10 GiB safety floor on a 36.17 GiB host.
- **Phase 2 Falsification & Correction:**
  1. The 10 GiB MemAvailable floor refusal was explicitly superseded for this initiative by human steering (`humanignoreRAM` / human message 2026-10-05).
  2. `MemoryMax=768M` is a cgroup v2 enforcement ceiling, not pre-allocated resident memory. Measured worker RSS ranges between 120 MiB and 430 MiB.
  3. The recommendation to lower `MemoryMax` to 512M is officially withdrawn.

### 2.4 Desktop Corrections: Provider Concurrency & Disk vs RAM Policy
- **ZAI Concurrency Ceiling vs Capacity:** Analyst 4's initial proposal invented an allocation of "26 ZAI + 20 Gemini/Bunny + 4 Codex = 50". As corrected by desktop oversight, the ZAI cap of 26 is a shared atomic occupancy ceiling across all host actors, NOT 26 guaranteed open slots. Furthermore, principal oversight (e.g. Codex) cannot be counted toward worker scale-out. Concurrency must be routed dynamically against fresh, measured, healthy provider allowances on concrete useful tasks.
- **20 GiB Floor is Root Disk, Not RAM:** Analyst 5 incorrectly termed the 20 GiB threshold in `launcher/resources.py` a "RAM safety floor". Code audit confirms lines 9–10 define `MIN_DISK_FREE_BYTES = 20 * 1024**3` and `WARN_DISK_FREE_BYTES = 30 * 1024**3` (root disk storage hygiene). Human RAM override remains intact; no dispatch may be refused solely on RAM floor.
- **Roster Burst vs Historical Census:** Analyst 3's inference that the 25-worker fleet died after <=48 seconds based on transcript mtimes cannot be extrapolated to refute the verified 17:21:24Z burst of 25 concurrent tool-executing subagents. The point-in-time milestone was real, but presenting it as a standing `CURRENT-UTC` roster without automated refresh or TTL expiration was a false-positive presentation defect.

---

## 3. Converged Architectural Consensus

The panel unanimously agrees on the five structural pillars required to operate reliable multi-agent concurrency:

1. **Watchdog Timeout Realism:** Worker payload execution timeouts must remain at 600s (`DEFAULT_CLEANUP_TIMEOUT_SEC = 600` landed in `a1e3f84`), preventing the premature SIGKILL storms that aborted 120s workers during deep reasoning turns.
2. **Readiness Feed Integrity:** The supervision service (`scripts/supervision/service.py`) must accumulate `ready_snapshots` across durable identity keys rather than volatile in-memory session IDs, accurately detecting idle panes while strictly preserving busy/draft-protected panes. Under no circumstances may timeout deliver wakes to unknown panes.
3. **Standing Non-Head Dispatch Loop:** Queue dispatch must run as a detached, standing daemon service (`watch_loop` under systemd) rather than relying on interactive project heads to manually run refill passes or arm fragile one-shot continuation timers.
4. **Substantive Disjoint Backlog:** Reaching 50 concurrency requires horizontal backlog depth. Heads must decompose deliverables into independent, non-overlapping tasks with explicit file leases, avoiding deep serial dependency chains that force the watch loop into dependency-wait state.
5. **Truthful Telemetry & TTL-Enforced Rosters:** Active worker rosters must enforce active heartbeats or short TTLs. Point-in-time burst receipts must never be labeled or queried as standing active worker fleets.

---

## 4. Preserved Dissents & Remaining Unknowns

### 4.1 Preserved Technical Dissents
- **Admission Sizing Policy (Analyst 2 vs Analyst 4/5):** Analyst 2 argues that static cgroup ceilings (768M) should be retained and coupled with strict root disk hygiene (20 GiB hard / 30 GiB warn), arguing that dynamic RSS admission introduces unpredictable thrashing under sudden worker memory spikes. Analysts 4 & 5 maintain that RSS-aware admission stages are necessary to prevent artificial queuing when workers average only ~200 MiB RSS.
- **Review Verification Automation (Analyst 1 vs Analyst 2):** Analyst 1 advocates for automated review-receipt validation on disk before advancing queue refills (`scale50-D`). Analyst 2 warns that over-automating review acceptance risks creating rubber-stamp reviews or deadlocking when independent reviewers identify subtle semantic flaws.

### 4.2 Truthful Open Unknowns
- **Worker Process Termination Root Cause in 17:21 Burst:** Transcripts for the 25 subagents ended abruptly between 17:21:50Z and 17:21:59Z. While head loss occurred at 17:22Z, the exact OS-level signal or process exit trigger terminating the subagent processes remains unrecorded in preserved systemd logs.
- **Exact Token & Financial Burn:** Historical token consumption during the failure loops remains unknown; quota percentages from provider dashboards cannot be converted to exact dollar expenditures.

---

## 5. Canonical Task Ownership & Executable Checkpoint Packet

In compliance with desktop governance (`01a11159-3a2d-7af1-9f99-4cefedf09ed3`), we distinguish published research proposals from **actual executable ownership**. The current state in canonical `TASKS.json` reflects un-ACKed or archived entries that require formal principal coordination:

| Task ID | Canonical Title | Current State in TASKS.json | Current Head Ownership Status | Concrete Executed Repair & Required Next Action | Real Next Checkpoint | Required Acceptance Evidence |
|:---|:---|:---|:---|:---|:---|:---|
| **`scale50-A-dispatch-repair`** | Repair watch loop & 600s cleanup timeout | Open, unACKed | Needs current QL head ACK | **Executed:** `a1e3f84` relaxed timeout to 600s; `eb9158e` added cleanup retry cooldown; `ca0581f` enforced cooldown on terminal states. **Next:** Land unit test verifying custom `--cleanup-timeout` parameter. | Oct 6 18:00 CEST | Unit test `test_watch.py` passing with custom 600s timeout assertion. |
| **`scale50-B-ready-allocation`** | Route fresh healthy provider allocations | Open, principal owner | Needs genuine multi-head routing | **Executed:** Dynamic failover to Gemini/Space Bunny verified. **Next:** Enforce ZAI atomic occupancy check (cap 26) in launcher capacity admission (`launcher/capacity.py`). | Oct 6 19:00 CEST | Live task unit admitted on Gemini when ZAI occupancy >= 26. |
| **`scale50-C-capacity-stages`** | Staged capacity admission & RSS monitoring | Current QL ACK | Due checkpoint expired | **Executed:** Generalization of `max_cap` in `6a506a1`. **Next:** Update due checkpoint in `TASKS.json` and implement staged 10->25->50 ramp with RSS telemetry. | Oct 6 20:00 CEST | Verified RSS log across 10-worker concurrent execution under `app.slice`. |
| **`scale50-D-dispatch-refill`** | Standing supervisor watch daemon | Archived owner (`a86056`) | Needs re-assignment to active head | **Executed:** Review-gating verified as per-task dependencies in `watch.py`. **Next:** Reassign ownership to active QL head; package `watch_loop` as a standing systemd user service (`agent-quota-watch.service`). | Oct 6 21:00 CEST | `systemctl --user status agent-quota-watch.service` active and draining queue. |
| **`scale50-E-roster-accountability`** | Roster TTL & evidence freshness verification | Open, unACKed | Needs Ant/QL head ACK | **Executed:** Identified byte-identity and lack of TTL in `ROSTER-25-ACTIVE-WORKERS-CURRENT-UTC.json`. **Next:** Add TTL self-expiry (300s) to roster JSON generators and reconcile against `/proc` PIDs. | Oct 6 22:00 CEST | Negative test rejecting stale (>300s) roster snapshot as UNKNOWN. |
| **`scale50-12`** | Task-ID/cgroup/receipt dedup projection | Blocked on owner-lease | Blocked | **Executed:** Analysis completed by Analyst 3. **Next:** QL head ACK against durable sender keys and wake-path fencing. | Oct 7 10:00 CEST | Fencing test rejecting ambiguous/dead session wake. |
| **`scale50-21`** | Supervision composer feed & readiness repair | Blocked, Oct 5 due | Needs Principal re-baselining | **Executed:** Scope 1 & Scope 3 audit of `eligible()` in `service.py:808`. **Next:** Principal re-baseline; patch `service.py` to persist `ready_snapshots` across session resets. | Oct 7 12:00 CEST | Zero `pending-blocked-beyond-slo` events emitted during 10-cycle idle test. |
| **`scale50-31`** | Dashboard candidate state freshness | Blocked on candidate-lease | Blocked | **Executed:** Reconciled in Scope 3 critique. **Next:** Dashboard head ACK to implement active/ended/unknown vocabulary matching supervision. | Oct 7 14:00 CEST | Dashboard displays UNKNOWN for terminated worker units. |

---

## 6. Staged Execution Gate & Verification Sequence

Before scaling worker concurrency toward the 50-worker target, the team must strictly enforce the staged progression gate:
1. **Gate 1: Useful Task Completion:** A real, unblocked, substantive task must execute to completion under standard containment (`MemoryMax=768M`, `TasksMax=100`).
2. **Gate 2: Distinct Independent Review:** An independent reviewer running under an isolated session must audit the diff, execute negative tests, and issue an unconstrained verdict report.
3. **Gate 3: First-Action Telemetry Proof:** Next-model dispatch must verify live first-tool action within 60s of admission before subsequent queue items are admitted.
4. **Safety Rule:** Readiness unknown must **never** be bypassed by timeout; all wakes must strictly respect busy, draft-protected, and NOTREADY states.
