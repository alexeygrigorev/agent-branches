# Joint Corrective Proposal: Resolving Scale-50 Concurrency Failures

**Date**: 2026-10-06  
**Authors**: 5-Analyst Panel & Ant Head Custody (`ant-head-never-timer-custody-20261006`)  
**Scope**: Unified root-cause resolution for useful 50 concurrency failures across Oct 3–6.  
**Repository**: Confined to `/home/alexey/git/agent-branches` under `.local/git.lock` (`cloudflare-agent-git` edit scope: `none`).

---

## 1. Executive Summary & Root-Cause Synthesis

Across Scopes 1–5, the panel has falsified the simplistic "host RAM exhaustion" and "ZAI hard ceiling" hypotheses and pinpointed the **real compound failure mechanisms** that prevented sustained 50 useful concurrency:

1. **Mis-scaled Control Plane Timeouts (Scope 1)**:
   - Task units were given a hardcoded 120s wall clock, while actual LLM turns require >170s (`disk-pressure-cleanup-44` measured 173.1s for a no-op turn). This triggered deterministic SIGKILL at ~123s, failing 45+ episodes and burning quota on a 300s cooldown loop. (Resolved in source via 600s timeout in commit `eb9158e`).
   - Supervisor watcher restarted whenever `status.json` age exceeded 120s (`supervision_watcher.sh`), even though supervision cycles legitimately exceed 120s under load. This caused 14 supervisor restarts on Oct 6, creating orphan sessions and `AckUncertain` lock contention.
2. **Serial Head Loop & Backlog Starvation (Scope 2)**:
   - Tasks were tied to a single interactive head loop for sequential submit→run→review→accept→refill cycles.
   - Refill stalled when tasks were held in `completed-awaiting-review`, starving the launcher queue (which sat at 0 queued tasks despite 58 defined slices).
3. **Empty Readiness Snapshot Pipeline (Scope 3)**:
   - `pending-blocked-beyond-slo` exploded exponentially (261 on Oct 4 → 1,060 on Oct 5 → 2,774 on Oct 6, totaling 4,095 events).
   - Because `ready_snapshots: 0` was permanently unpopulated, the supervisor policy blocked message delivery indefinitely to "unknown" recipients instead of delivering with a fallback annotation.
4. **Falsification of RAM Floor & Multi-Provider Allocation (Scope 4)**:
   - *Refuted*: Claim that 50 workers * 768M = 38.4 GiB violates the 10 GiB RAM floor. The 10 GiB RAM floor is explicitly superseded for this initiative (`humanignoreRAM`). `MemoryMax=768M` is a cgroup upper boundary, not wired memory. Measured worker RSS is ~120M–430M (depending on provider and subprocess fan-out). While aggregate memory cannot be linearly assumed (e.g. 50 * 250M = 12.5 GiB), empirical measurements demonstrate substantial physical headroom well within the 36.17 GiB MemAvailable. A 512M profile is therefore not mathematically mandatory, though cgroup containment remains essential.
   - *Roster Qualification*: The 25-worker roster (`ROSTER-25-ACTIVE-WORKERS-20261005.json`) is recognized as a specific historical snapshot (Oct 5 17:21:24Z), not a live continuous concurrency baseline.
   - *Refuted*: Claim that ZAI 26 is a global concurrency ceiling. ZAI 26 is a single-backend occupancy limit. Sustained concurrency must be distributed across healthy providers (Gemini, Go, Space Bunny, Codex, ZCode).
5. **Decoupling Dependency Gating from Concurrency (Scope 5)**:
   - Code audit of `launcher/watch.py` confirmed `wait_for_review` defaults to `"dependencies"`. Disjoint, independent tasks can and must dispatch concurrently without waiting for unrelated tasks to be reviewed.

---

## 2. Concrete Corrective Action Matrix

| Action ID | Scope | Target Component | Proposed Concrete Repair | Owner | Acceptance Criteria |
|---|---|---|---|---|---|
| `REPAIR-S1-01` | Scope 1 | `agent-quota-launcher` | Codify provider-aware task timeouts (minimum 600s for model turns) and persist `DEFAULT_CLEANUP_TIMEOUT_SEC = 600` across all launcher state databases. | QL Head | Zero cleanup tasks terminated by SIGKILL at 120s; cleanups exit 0 and complete cleanly. |
| `REPAIR-S1-02` | Scope 1 | `supervision_watcher.sh` | Relax supervision watcher staleness threshold from 120s to 600s, requiring two consecutive stale checks before restart. Heartbeat `status.json` at cycle start. | Supervision Head | Supervisor restarts drop from 14/day to <3/day; zero `AckUncertain` lock bursts. |
| `REPAIR-S1-03` | Scope 1 | Launcher State DBs | Designate `~/.config/agent-quota-launcher/state.db` as canonical, or include all live candidate DBs in monitoring. Namespace dedup keys. | QL Head | Single canonical queue-drained metric; zero collision of `disk-pressure-cleanup-N` IDs. |
| `REPAIR-S2-01` | Scope 2 | Launcher Dispatch | Decouple review gating: ensure `wait_for_review="dependencies"` allows all ready, dependency-free queued tasks to dispatch immediately up to capacity. | Ant / QL Head | Queue depth >0 immediately triggers parallel launches up to host/provider limits. |
| `REPAIR-S2-02` | Scope 2 | Continuation Timers | Enforce `TimerCondition="never"` on all critical continuation timers; add supervisor-owned heartbeat pings to eliminate head custody loss. | Ant / Codex | Zero premature timer cancellations; zero unmaintained custody gaps (>15m). |
| `REPAIR-S3-01` | Scope 3 | Supervision Delivery | Fix readiness pipeline: populate `ready_snapshots` or deliver with explicit `readiness-unknown` annotation once SLO expires (300s). | Supervision Head | `pending-blocked-beyond-slo` events drop from 2,774/day to <50/day. |
| `REPAIR-S4-01` | Scope 4 | Provider Routing | Implement multi-provider concurrency routing: cap ZAI at 26, overflow to AGY Gemini 3.1 Pro (up to 20), OpenCode Space Bunny, and Go. | QL Head / Ant | Sustained 50 concurrent active workers without 429 rate limits or host OOM. |

---

## 3. Immediate Implementation & Falsification Plan

1. **Phase 1: Control-Plane Bound Alignment (Immediate)**:
   - Verify `agent-quota-launcher` timeout defaults remain at 600s across all units.
   - Adjust `supervision_watcher.sh` staleness check to 600s.
2. **Phase 2: Readiness & Dispatch Decoupling**:
   - Reconcile `TASKS.json` to ensure ready backlog tasks have valid payloads and dependencies.
   - Validate that queue refills dispatch parallel units without waiting for unrelated reviews.
3. **Phase 3: Multi-Provider 50 Concurrency Ramp**:
   - Dispatch 25 ZAI + 25 Gemini/Space Bunny task units under `app.slice`.
   - Monitor real-time memory usage (confirm total RSS < 18 GiB) and provider HTTP status codes.

---

## 4. Bounded StorageBox Cold Archive Plan

**Target Remote**: Hetzner StorageBox (1 TB allocated, 1024 GB available, SFTP22 verified via dedicated ed25519 key).  
**Ownership**: Accepted by Ant Head Custody (`ant-head-never-timer-custody-20261006`).  
**Principles**: Zero filesystem mounts, zero bulk deletions, zero cloud/provider spend ($0.00). Strict encryption/privacy, checksum verification, and test restore before any local pruning.

### 4.1 Cold Candidate Byte Enumeration
1. **Historical Supervision Archives (`.local/supervision/`)**: ~21 MB of rotated logs and events older than 24h.
2. **Historical Recovery Directories (`.local/recovery/`)**: ~467 MB of previous completed recovery bundles and forensic captures.
3. **Historical Scale-50 Forensic Outputs (`.local/scale50/`)**: ~13 MB of completed run collation outputs.
- **Strictly Excluded / Preserved Locally**: Active databases (`state.db`), live credential files (`.cred.json`, `~/.config/`), active git worktrees, active build caches, and currently active task workspaces.

### 4.2 Safe Execution Protocol (Four-Stage Verification Gate)
1. **Archive & Checksum**: Package cold files into tarballs with SHA256 checksums recorded locally.
2. **Encrypted SFTP Transfer**: Upload via SFTP port 22 using dedicated key (`~/.ssh/hetzner-storagebox-agent-archives_ed25519`).
3. **Roundtrip Integrity Test**: Download remote archive to a temporary scratch location and verify SHA256 match.
4. **Gated Pruning**: Only upon 100% roundtrip SHA256 verification may cold local files be pruned to reclaim disk space.

