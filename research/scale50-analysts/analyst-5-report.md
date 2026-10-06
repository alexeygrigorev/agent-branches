# Analyst 5 Report: Scope 5 - Architecture, Process, and Serial Bottlenecks

**Date**: 2026-10-06  
**Analyst**: Analyst 5 (AGY gemini-3.1-pro-high)  
**Scope**: Architecture / process / human-intervention bottleneck, independently challenge serial infrastructure loops.  
**Objective**: Investigate why useful 50 concurrency repeatedly failed on Oct 3-6, analyze root causes, evidence vs unknowns, and propose the fastest safe fix.

---

## 1. Executive Summary

The failure to achieve useful 50 concurrency during the Oct 3-6 window is primarily rooted in an intentionally introduced **serial infrastructure loop** masquerading as a safety mechanism. The `agent-quota-launcher` architecture was modified to halt all new task dispatch if *any* previously completed task is awaiting review (`completed-awaiting-review`). This creates a hard human-intervention bottleneck that fundamentally serializes execution and prevents concurrency from scaling beyond 1 active task at a time. 

Additionally, an architectural resource constraint guarantees that 50 concurrent workers at the current 768M memory profile will exceed safe host memory limits, ensuring mechanical failure even if the software bottleneck is removed.

## 2. Root Cause Analysis (Evidence vs Unknowns)

### A. The Serial Infrastructure Loop (The Primary Bottleneck)
* **Evidence**: According to `.local/scale50/REMOTE-AUTONOMY-LAUNCHER-1830.md`, commit `8486acf` introduced a strict serialization logic: `_next_dispatchable(store, wait_for_review=True)` checks `_unreviewed_task_ids`. 
* **Mechanism**: If *any* task is in `completed-awaiting-review`, automatic refill waits and explicitly **refuses to dispatch subsequent queued tasks**. 
* **Impact**: Instead of N tasks running concurrently, the queue halts entirely until an external reviewer (human or independent agent) acts. This guarantees 1-by-1 serial execution, making 50 concurrency mathematically impossible.

### B. The Human-Intervention Bottleneck
* **Evidence**: The system relies on `launcher accept` to trigger a review-gated refill.
* **Mechanism**: When `launcher accept` is called, it triggers `watch_loop(refill_args, max_passes=1)`, which only dispatches the *next* queued task.
* **Impact**: The pace of automated agents is artificially throttled to the pace of human review/acceptance, breaking the autonomous loop.

### C. Architectural Memory Constraint
* **Evidence**: The physical Hetzner host (`hetzner-bare-metal-main`) has 36.17 GiB `MemAvailable`. The mandatory safety floor requires 10 GiB MemAvailable at all times.
* **Mechanism**: At the current 768M `MemoryMax` limit per worker, 50 workers require **38.4 GiB RAM**.
* **Impact**: Attempting 50 concurrent workers on the single host will violate the 10 GiB floor and trigger OOM conditions. 

## 3. Fastest Safe Fix Proposed

To restore genuine concurrency while maintaining safety, the serialization logic must be decoupled from the review process.

1. **Eliminate the Serial Loop (Software Fix)**:
   - Remove the `wait_for_review=True` gate from `_next_dispatchable`. 
   - Modify `watch_loop` so that dispatching the next `ready` task is gated **only** by available compute resources (active PIDs, RAM, CPU), never by the review status of previously completed tasks.
   - Refills should trigger automatically on worker exit regardless of pending reviews.

2. **Optimize Memory Profiles (Architecture Fix)**:
   - To safely reach 50 concurrency on the current host, lower the worker `MemoryMax` profile from 768M to **512M**.
   - 50 workers at 512M will consume 25.6 GiB RAM, leaving 10.57 GiB margin, strictly complying with the 10 GiB safety floor.
   - *Alternative*: If 512M causes application-level OOMs for the workers, the architecture must transition to cross-host provisioning before attempting 50 concurrency.

By implementing these two changes, the system can parallelize up to 50 tasks autonomously without waiting for serial reviews, safely respecting hardware bounds.
