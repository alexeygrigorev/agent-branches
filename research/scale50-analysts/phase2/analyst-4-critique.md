# Phase 2 Critique: Scope 4 (Provider Routing, Quota, Occupancy & Resources)

**Analyst:** Successor Analyst 4 (Scope 4)
**Phase:** Phase 2 (Mutual Cross-Reading)
**Date:** 2026-10-06

This critique rigorously addresses the flaws in my own Phase 1 draft report regarding the root causes of the Oct 3-6 concurrency failures. It falsifies the initial claims about the RAM floor and corrects the provider concurrency model, followed by a concrete multi-provider routing proposal.

## 1. Falsification of RAM Floor Claim and Withdrawal of 512M Drop

In the initial draft, I claimed that 50 workers with a `MemoryMax=768M` profile mathematically guaranteed physical RAM exhaustion because it would exceed the 36.17 GiB `MemAvailable` while violating a "mandatory 10 GiB safety floor." 

This claim is incorrect and must be withdrawn for the following reasons:
*   **Superseded Constraint:** The 10 GiB `MemAvailable` floor constraint was superseded by explicit human steering (`humanignoreRAM`), rendering the strict floor block invalid.
*   **Cgroup Boundary vs. Reservation:** The `MemoryMax=768M` parameter is a systemd cgroup boundary (a hard ceiling), not a fixed baseline reservation. Tasks do not reserve 768M upon launch; their actual physical memory footprint is significantly lower. Therefore, 50 workers will not deterministically consume 38.4 GiB.
*   **Withdrawal:** The recommendation to drop the `MemoryMax` profile to `512M` is officially withdrawn. It was based on a flawed assumption that cgroup limits equate to immediate physical allocations, and it introduces unnecessary OOM risk for legitimate spikes.

## 2. Clarification of Provider Concurrency and Global Ceilings

My Phase 1 draft incorrectly conflated the ZAI-specific rate limit with a global concurrency ceiling. 

*   **ZAI Occupancy Limit:** The verified cap of 26 concurrent sessions applies *only* to the ZAI backend (GLM-5.3-Flash). It is a single-backend atomic occupancy limit, not a systemic bottleneck that prevents 50 total concurrent workers.
*   **Multi-Provider Feasibility:** The architecture supports multi-provider routing. Reaching 50 concurrency simply requires utilizing the verified healthy alternatives (AGY Gemini 3.1 Pro, Space Bunny, Codex) in parallel with the 26 ZAI slots, rather than routing all traffic monolithically through ZAI. 

## 3. Concrete Multi-Provider Routing Proposal

To safely achieve and sustain 50 concurrent workers without hitting single-provider API constraints, we must implement explicit multi-provider routing. Below is the proposed capacity allocation mapped directly to the canonical `TASKS.json` workload IDs:

*   **ZAI (GLM-5.3-Flash): 26 Slots (Max Occupancy)**
    *   **Mapping:** Allocate to routine autonomous tasks, high-throughput pipelines, and general scale-out. 
    *   **Target TASKS.json ID:** `scale50-B-ready-allocation`
*   **AGY Gemini (3.1 Pro) / Space Bunny: 20 Slots**
    *   **Mapping:** Allocate to deep reasoning, complex analysis, head scheduling, and independent review.
    *   **Target TASKS.json ID:** `scale50-06`
*   **Codex (Reserve): 4 Slots**
    *   **Mapping:** Retain for critical principal oversight, cross-reading, and system coordination.
    *   **Target TASKS.json ID:** `scale50-10`

**Total Concurrent Capacity:** 26 (ZAI) + 20 (Gemini/Space Bunny) + 4 (Codex) = 50 Slots. 

This routing resolves the 429 rate limits natively by distributing the load within each provider's proven boundaries, enabling full utilization of the 50-worker scale.
