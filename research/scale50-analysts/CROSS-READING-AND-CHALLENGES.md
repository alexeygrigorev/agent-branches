# Mutual Cross-Reading, Challenges, and Dissent Analysis

**Panel**: 5-Analyst Scale-50 Failure Investigation Panel  
**Date**: 2026-10-06  
**Scope**: Rigorous cross-reading of initial draft reports (Analysts 1–5), factual falsification, preserved dissent, and synthesized consensus.

---

## 1. Challenge & Falsification Matrix

### Challenge 1: Host RAM Floor & Mandatory 512M Memory Profile
- **Challenged Claims**:
  - Analyst 4: "Attempting 50 concurrency at 768M mathematically guarantees violating the 10 GiB safety floor... mathematically necessary to drop worker memory to 512M."
  - Analyst 5: "At the current 768M MemoryMax limit per worker, 50 workers require 38.4 GiB RAM... trigger OOM conditions."
- **Challengers**: Analysts 1, 2, 3 and Ant Head Custody.
- **Evidence & Falsification**:
  1. *Policy Override*: The 10 GiB MemAvailable floor was explicitly superseded for this initiative (`RESOURCE-POLICY` actual RAM override / `humanignoreRAM`).
  2. *Cgroup Ceiling vs Allocated RSS*: In Linux cgroups v2, `MemoryMax=768M` is an upper limit enforced by the kernel, not wired or reserved memory.
  3. *Empirical Telemetry*: Measured worker RSS across live task units:
     - Analyst 1 (zcodex + zcode-cli): 429M peak RSS.
     - Analyst 2 (zcodex + zcode-cli): 380M peak RSS.
     - Analyst 3 (zcodex + zcode-cli): 364M peak RSS.
     - Python worker units (`t-branches-recovery-pipeline-c2852`, `t-bus-model-standalone`): ~120M–180M RSS.
  4. *Mean Concurrency Load*: Mean worker RSS is ~250M. 50 concurrent workers consume approximately 12.5 GiB of physical memory, safely within the host's 36.17 GiB MemAvailable.
- **Resolution**:
  - The claim that a 512M profile is mathematically necessary to avoid physical host exhaustion is **falsified**.
  - *Dissent / Qualification Preserved*: Rigid linear extrapolation (assuming exactly 12.5 GiB for all workloads) is withdrawn. Memory consumption depends on model adapter, tool subprocesses, and compiler jobs. Real cgroup containment at 768M remains mandatory, and memory headroom must be monitored during staged ramp-up (10 -> 25 -> 50).

---

### Challenge 2: Global Concurrency Halt on Commit `8486acf`
- **Challenged Claim**:
  - Analyst 5: "Commit 8486acf introduced a strict serialization logic: if any task is in `completed-awaiting-review`, automatic refill waits and explicitly refuses to dispatch subsequent queued tasks."
- **Challengers**: Analysts 1, 2 and Ant Head Custody.
- **Evidence & Falsification**:
  1. *Code Audit of `launcher/watch.py`*:
     - Line 172: `wait_for_review = getattr(args, 'wait_for_review', "dependencies")`.
     - Lines 79–85: `if wait_for_review == "global": unreviewed = _unreviewed_task_ids(store); if unreviewed: return None, ...`.
     - Lines 111–135: Under the default `"dependencies"`, `_next_dispatchable` inspects `payload.get("depends_on")` or `payload.get("dependencies")`. Only queued tasks that explicitly declare an unreviewed task in their dependency array are blocked.
  2. *Empirical Verification*: Disjoint, independent queued tasks with no unreviewed dependencies dispatch immediately in `watch_loop`.
- **Resolution**:
  - The claim that commit `8486acf` universally halts dispatch on any unreviewed task is **falsified**.
  - *Preserved Practical Dissent*: While the software permits disjoint dispatch, the *backlog* frequently lacked independent ready tasks because tasks were chained sequentially, creating practical queue starvation.

---

### Challenge 3: Root Cause of Delivery Outage & Blocked Wakes (Scope 1 vs Scope 3)
- **Scope 1 Hypothesis (Analyst 1)**: Attributed delivery failures to supervision watcher restarts (14 restarts on Oct 6) caused by a rigid 120s staleness threshold on `status.json`.
- **Scope 3 Evidence (Analyst 3)**: Discovered that `pending-blocked-beyond-slo` exploded from 261 (Oct 4) -> 1,060 (Oct 5) -> 2,774 (Oct 6) = 4,095 events, because the readiness snapshot pipeline was empty (`ready_snapshots: 0`).
- **Orchestrator Guidance & Falsification**:
  - Analyst 1 proposed delivering with a `readiness-unknown` annotation after SLO expiry.
  - *Correction*: Desktop orchestrator explicitly directed: "NEVER deliver to readinessunknown composer based on timeout/annotation; repair genuine feed/ownedqueue/custody respecting busy/drafts/NOTREADY."
- **Reconciliation**:
  - Do NOT deliver blindly to unknown recipients on timeout.
  - Genuine fix requires:
    1. Repairing the readiness composer pipeline so `ready_snapshots` correctly reflects active/busy/ready states.
    2. Extending `supervision_watcher.sh` staleness threshold from 120s to 600s to eliminate false restart churn.

---

### Challenge 4: Evidence False Positives vs Real Capacity (Scope 3 vs Scope 2)
- **Scope 3 Finding (Analyst 3)**: `ROSTER-25-ACTIVE-WORKERS-20261005.json` was a static snapshot of <=48-second worker lifetimes; `TEAM-REGISTRY.json` listed dead PIDs as `running`; `task_event()` counted blocked/review/accepted work as "active".
- **Scope 2 Finding (Analyst 2)**: Concurrency was bound by backlog ownership: of 58 scale50 slices, only ~12–17 had genuine owner ACKs.
- **Reconciliation**:
  - False positive metrics masked the fact that real concurrent execution was collapsing.
  - Must implement:
    1. Self-expiring "active" state (reconcile against `/proc` and transcript mtime <= 5m).
    2. Reconcile `TASKS.json` status vocabulary so only genuinely executing units count as active.
    3. Ensure ready backlog tasks have valid payloads and explicit owner ACKs.

---

## 2. Summary of Consensus Findings

1. **Timeout Mismatch was the Primary Mechanical Killer**: Task units were given a 120s wall clock while LLM turns took >170s, causing deterministic SIGKILL across 45+ episodes. (Fixed in source via 600s timeout in `eb9158e`).
2. **RAM Floor is Not a Barrier**: Host has 36.17 GiB MemAvailable; 10 GiB floor is superseded (`humanignoreRAM`); worker RSS is ~120M–430M; 50 workers take ~12.5 GiB physical RAM.
3. **ZAI 26 is a Single-Provider Ceiling**: Must route across mixed healthy providers (Gemini, Go, Space Bunny, Codex, ZCode).
4. **Decouple Review Acceptance from Disjoint Dispatch**: Keep dependency gating for dependent tasks, but allow independent ready tasks to dispatch freely.
5. **Self-Expiring Roster & Process Reconciliation**: Discard point-in-time snapshots as standing baselines; reconcile all active claims against `/proc` and live transcript mtimes.
