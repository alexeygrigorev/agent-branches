# Phase 2 Addendum — Successor Analyst 5 (Scope 5)

**Date:** 2026-10-06
**Author:** Successor Analyst 5 (Scope 5)
**Context:** Phase 2 Mutual Cross-Reading Addendum

This addendum issues strict factual corrections against my own prior draft and peer drafts, finalizing the Scope 5 architectural stance. Every load-bearing claim has been aligned with explicit operating constraints and factual evidence from the provided repositories.

## 1. Accepted Peer Claims

- **Analyst 2 (S2.1 & S2.2 - Dispatch Gates):** Accepted with citations. The core bottleneck was the single serial head loop and an empty independent-ready backlog, not a global `wait_for_review` software gate. The `watch.py` script correctly defaults to per-task `dependencies`. Cross-task gating only applied to explicitly declared dependency chains, validating the observation that independent tasks were legally dispatchable if available.
- **Analyst 3 (Section 2 - Unknown Composers):** Accepted with citations. We must NEVER deliver supervisor wakes to unknown composers based on timeout. Readiness-unknown bypass is strictly forbidden under system policy. Delivering on timeout fabricates readiness and risks destroying peer drafts. Genuine composer-feed repair is categorically required.

## 2. Rejected Peer Claims and Factual Corrections

- **Self-Correction (Analyst 5) on 20 GiB Floor:** I formally retract my own prior claim that `launcher/resources.py` implements a 20 GiB RAM floor. This was a critical misread of the codebase. The 20 GiB threshold is strictly the **ROOT DISK** policy, NOT a RAM floor. The explicit human RAM override remains in full effect, and physical RAM was never mathematically exhausted as previously claimed.
- **Analyst 4's Static Provider Allocations:** I reject Analyst 4's proposal to invent static allocations across providers (e.g., 26 ZAI + 20 Gemini + 4 Codex). The shared ZAI 26 limit is an atomic occupancy ceiling, not a block of open slots to be statically partitioned. Furthermore, principal oversight does not count toward the worker 50 scaling target. Concurrency must route dynamically to fresh, measured healthy tasks rather than adhering to rigid, pre-allocated bins.
- **Analyst 3's <=48sec Worker Lifetime Inference:** I reject Analyst 3's conclusion that worker lifetimes were universally <=48 seconds based solely on transcript `mtime` values. File `mtime` does not inherently equal execution lifetime, and an early census snapshot cannot categorically refute a later execution burst. Do not prompt-defend this flawed heuristic.
- **Analyst 2's Watcher Inference:** I reject the inference drawn by Analyst 2 regarding the watcher state. The current absence of a loaded watcher cannot be used to retroactively infer the state of the October 5 `TASKS.json` snapshot.

## 3. Remaining Technical Dissents

- **Worker Termination Mechanisms:** We must preserve the technical dissent regarding worker termination. Without definitive process-level kill records or telemetry, we cannot scientifically assert that workers died at 45-48 seconds solely based on transcript write boundaries. The exact mechanism ending worker lives remains genuinely unidentified.
- **Generation-Bound Readiness Verification:** Active state accumulation and identity tracking must remain strictly generation-bound. We cannot allow stable tag transfer across restarts; the system must prove fresh liveness for every single generation. Restart churn fundamentally resets state, and the system must reflect this truthfully.

## 4. Concrete Next Action / Canonical Task ID

**Task ID:** `scale50-12` (Task-ID/cgroup/receipt dedup projection)
- **Concrete Action:** Execute genuine composer feed repair. Ensure that readiness snapshots are emitted only from verified liveness sources (PID-backed live session + genuine activity). Guarantee that readiness accumulation remains generation-bound and fresh, explicitly preventing any timeout deliveries to unknown composers.

**Task ID:** `scale50-D-dispatch-refill`
- **Concrete Action:** Refine the dispatch loop to support dynamic multi-provider routing. The dispatcher must respect atomic occupancy ceilings (like the ZAI 26 cap) on the fly, dynamically routing to fresh, measured healthy tasks without relying on invented static provider allocations.
