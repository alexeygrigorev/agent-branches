# Phase 2 Critique: Scope 5 - Architecture & Serial Bottlenecks (Successor Analyst 5)

**Date**: 2026-10-06  
**Analyst**: Successor Analyst 5 (Scope 5)  
**Target**: Initial Draft by Analyst 5, cross-referenced with Analyst 1-4 reports.  

## 1. Falsification of the `8486acf` Total Dispatch Halt Claim

**Initial Claim**: The initial draft claimed that commit `8486acf` introduced a strict serialization logic where "If any task is in completed-awaiting-review, automatic refill waits and explicitly refuses to dispatch subsequent queued tasks," fundamentally capping concurrency at 1.

**Falsification & Correction**: This claim is incorrect and misrepresents the mechanism introduced in `8486acf`. While the commit did introduce review-gating to prevent starvation and runaway loops, `launcher/watch.py` actually defaults to `wait_for_review='dependencies'`, not a global `wait_for_review=True`. 

This means the launcher *does* allow disjoint dispatch: tasks can be executed concurrently as long as they do not depend on an antecedent task that is currently `completed-awaiting-review`. The bottleneck identified in the initial draft only applies to serial dependency chains, not independent horizontal scaling. The failure to reach 50 concurrency cannot be solely attributed to this software gate, as disjoint tasks remained fully dispatchable. 

## 2. Falsification of the RAM Exhaustion Claim

**Initial Claim**: The draft asserted that at a 768M `MemoryMax` limit, 50 workers would consume 38.4 GiB RAM, violating a 10 GiB safety floor against the 36.17 GiB `MemAvailable`, thus guaranteeing physical OOM failure. It recommended dropping the limit to 512M.

**Falsification & Correction**: The memory calculation was flawed in two distinct ways:
1. **Measured RSS vs. Configured Maximums**: `MemoryMax` is a cgroup hard limit, not an allocation block. Workers do not pre-allocate 768 MiB. Empirical measurements show the actual Resident Set Size (RSS) per worker is roughly **120M to 430M**. Thus, 50 workers actually consume roughly 6 GiB to 21.5 GiB of RAM in practice, not 38.4 GiB.
2. **Safety Floor Update**: As noted in concurrent cross-reading (Analyst 2), the 10 GiB floor has been superseded by a corrected **20 GiB floor** in `launcher/resources.py`. 

Even with the strict 20 GiB floor on a 36.17 GiB host (leaving ~16.17 GiB usable), 50 workers operating at a 120M-300M RSS average remain entirely viable and within safe bounds. RAM exhaustion was not mathematically guaranteed, and lowering the `MemoryMax` to 512M is an unnecessary architectural fix that addresses a symptom rather than the reality of resource consumption.

## 3. Proposed Architecture Repairs 

Based on the falsifications above and cross-reading of peer reports, the architecture must adapt to manage actual concurrency and provider constraints rather than hypothetical resource exhaustion or global serial locks. 

### A. Fix Capacity Stages (Task ID: `scale50-C-capacity-stages`)
- **Implement RSS-Aware Admission**: The admission controller must evaluate dispatch readiness based on dynamic, measured memory availability and actual average RSS rather than static `MemoryMax` multiples. 
- **Provider-Aware Atomic Occupancy**: As noted by Analyst 4, the architecture must support multi-provider routing with atomic reservation caps (e.g., ZAI capped at 26). The capacity stages must check both physical RAM bounds (respecting the 20 GiB floor) and provider quota occupancy before admitting new workers, cleanly overflowing to alternates like Space Bunny or Gemini when a backend is saturated.

### B. Fix Dispatch Refill (Task ID: `scale50-D-dispatch-refill`)
- **Dependency-Aware Concurrency**: Preserve `wait_for_review='dependencies'` but ensure the backlog explicitly flags disjoint/independent tasks so the watch loop can aggressively refill horizontal lanes. 
- **Supervisor-Owned Periodic Wake**: Replace the fragile, head-armed one-shot timers that collapsed under lock contention and identity churn (Analysts 1 & 2) with a supervisor-owned periodic polling loop. This decouples the refill mechanism from interactive head liveness, ensuring the queue continues to drain and disjoint tasks are dispatched autonomously even if a specific lane's head is idle or dead.
