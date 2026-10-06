# Scope 4 Failure Analysis: Provider Routing, Quota, Occupancy & Resources

**Analyst:** Analyst 4 (Scope 4)
**Date:** 2026-10-06
**Focus:** Provider routing, quota, atomic occupancy, resources, admission, and healthy alternatives

## 1. Causal Timeline and Root Causes of Scale-50 Failures (Oct 3-6)

The goal of 50 useful concurrent workers repeatedly failed due to two intersecting systemic limits on single-provider quota and physical host resources.

### Root Cause A: Physical RAM Exhaustion (Admission & Resources)
According to the `REMOTE-AUTONOMY-LAUNCHER-1830.md` checkpoint logs and host telemetry:
- The Hetzner bare-metal instance has **~36.17 GiB MemAvailable**.
- A mandatory safety floor of **10 GiB MemAvailable** is strictly enforced.
- At the current `MemoryMax` profile of **768M per worker**, 50 concurrent workers would require **38.4 GiB RAM**.
- Attempting 50 concurrency at 768M mathematically guarantees violating the 10 GiB safety floor, causing the admission gate to block dispatches or system OOM kills.

### Root Cause B: Single-Provider Rate Limits (Quota & Atomic Occupancy)
According to the `zai-shared-concurrency-intake-20261005.md` human intake:
- ZAI (glm-5.3-flash) experienced consistent 429 rate-limiting errors.
- The human-approved and empirically validated shared backend ceiling for ZAI across all projects is **26 concurrent sessions**.
- Attempting 50 concurrency using a monolithic ZAI provider configuration caused immediate rate limit failures because the atomic occupancy of ZAI actors exceeded the hard cap of 26.

## 2. Evidence vs Unknowns

**Evidence:**
- **Host RAM limit:** `MemAvailable` verified at 36.17 GiB; 50 * 768M = 38.4 GiB (exceeds available memory).
- **ZAI Quota/Occupancy ceiling:** Human and empirical logs confirm a hard ceiling of 26 active ZAI backend actors before 429s occur.
- **Provider Alternatives:** "Fresh quse" metrics from Oct 6 (e.g., Gemini87.37fivehour, Go100fivehour) prove healthy alternatives have available capacity.

**Unknowns:**
- **Worker 512M viability:** It is mathematically necessary to drop worker memory to 512M to achieve 50 concurrency on this host, but empirical CLI stability (OOM likelihood) at 512M is not fully proven across all workloads.
- **Cross-machine occupancy:** Remote unaccounted jobs could still eat into shared ZAI quotas if not strictly measured.

## 3. Fastest Safe Fix

To safely achieve 50 useful concurrency without new cloud spend, we must implement a two-pronged adjustment to the quota launcher and admission controller:

1. **Memory Profile Reduction:**
   - Drop the `MemoryMax` limit per worker from **768M to 512M**.
   - **Math:** 50 workers * 512M = 25.6 GiB. This leaves 10.57 GiB of MemAvailable, which satisfies the mandatory >10 GiB floor (36.17 GiB - 25.6 GiB = 10.57 GiB).

2. **Multi-Provider Routing & Atomic Reservation:**
   - Implement explicit multi-provider routing instead of relying solely on ZAI.
   - Enforce an atomic shared reservation cap of **26 for ZAI**.
   - Overflow remaining dispatches automatically to healthy alternatives with fresh quota (e.g., **24 slots routed to AGY Gemini 3.1 Pro or Space Bunny**).
   - Ensure the admission controller checks both RAM constraints and per-provider atomic occupancy before launching the systemd task units.
