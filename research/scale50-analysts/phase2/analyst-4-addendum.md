# Phase 2 Addendum — Successor Analyst 4 (Scope 4)

- **Date:** 2026-10-06
- **Target:** Phase 2 cross-reading (Analyst 1-5 critiques)
- **Scope:** Provider Routing, Quota, Occupancy & Resources

## 1. Accepted Peer Claims

*   **Empty Readiness Pipeline (Analyst 3, Section 2 / Analyst 1, Section 1):** Accepted. The composer feed structurally starved due to identity churn and restart resets, failing to accumulate the necessary readiness snapshots. I fully endorse the categorical rejection of timeout-based delivery to unknown composers. Readiness-unknown bypass is strictly forbidden; we must execute genuine feed repair respecting busy/draft states.
*   **Backlog Bottleneck (Analyst 2, Section 1 S2.3):** Accepted. The primary constraint was a lack of independent, substantive ready tasks, not a global launcher review gate. The system correctly gated dependent tasks while independent ones starved for supply.
*   **Single-Shot Refill Limitations (Analyst 2, Section 2):** Accepted that the accept-path refill acts as a single-shot execution, converting review cadence into dispatch cadence when standing loops are absent.

## 2. Rejected Peer Claims & Technical Rationale

*   **Transcript mtime Infers Lifetime (Analyst 3, Section 1 / Analyst 2, Section 3):** Rejected. The claim that the Oct 5 burst workers lived "≤48 seconds" based solely on transcript `mtime` is technically flawed. `mtime` records the last file write, not process termination. An early transcript census cannot refute a later operational burst. I explicitly refuse to prompt-defend this false equivalence.
*   **20 GiB Floor Misattribution (Analyst 2, Section 1 S2.5 / Analyst 5, Section 2):** Rejected. Multiple peers misidentify the 20 GiB floor in `launcher/resources.py` as a RAM boundary. This is a **root disk** policy. The human `MemAvailable` RAM override remains explicitly in effect, and conflating disk with memory corrupts the admission model.
*   **Static Provider Allocation (Analyst 4, Section 3):** Retracting my own previous proposal of a 26+20+4 static provider split. Shared ZAI 26 is an atomic occupancy ceiling, not pre-allocated open slots, and principal oversight (Codex) does not count toward the worker 50 goal. Concurrency must route dynamically to fresh, measured, healthy tasks.
*   **Current Watcher State Infers Oct 5 (Analyst 2, Section 1 S2.1):** Rejected. Analyst 2 asserts the Oct 5 dispatch loop was not a standing service based on a current "0 loaded units" observation. Current loaded watcher absence cannot be used to definitively infer the Oct 5 `TASKS.json` historical snapshot state.
*   **Stable Tag Transfer for Readiness (Analyst 3, Section 2):** Rejected. Analyst 3 proposes durable sender keys (stable actor tags across restarts) for readiness. This violates generation boundaries. Readiness accumulation must be generation-bound and strictly fresh; stable tag transfers across restarts are prohibited.

## 3. Remaining Technical Dissents

*   **Burst Termination Mechanism:** With the 48-second transcript `mtime` inference falsified, the actual mechanism that ended the 25-worker burst remains unknown and requires investigation of actual process accounting (`/proc` or cgroup records), not log timestamps.
*   **Historical Throughput Bottleneck:** While the backlog was definitively starved, the exact contribution of the accept-path refill during the Oct 5 window remains unresolved, as historical watcher service state cannot be assumed from current absence.

## 4. Concrete Next Action & Canonical Task ID

*   **Canonical Task IDs:** `scale50-12` (quota-launcher dedup projection) and `scale50-B-ready-allocation` (dynamic multi-provider routing).
*   **Next Actions:** 
    1. **Dynamic Routing (`scale50-B`):** Implement dynamic, health-measured routing to the execution pool (ZAI, AGY Gemini, Space Bunny). Route strictly to fresh, substantive tasks under the ZAI 26 atomic ceiling without static slot reservations.
    2. **Fresh Readiness Accumulation (`scale50-12`):** Fix the composer feed to accumulate readiness snapshots strictly within the current generation boundary. Implement hard epoch fencing so stale restarts explicitly fail, ensuring zero wakes are delivered to unknown or timed-out composers.
