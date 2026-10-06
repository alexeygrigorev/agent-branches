# Phase 2 Addendum — Successor Analyst 2 (Scope 2: scheduling, backlog, refill, custody, timers, dispatch)

- **Date:** 2026-10-06 (Europe/Berlin).
- **Inputs:** all five Phase 2 critiques in `research/scale50-analysts/phase2/` (analyst-1 … analyst-5).
- **Method:** claims cite the pinned critiques and my Phase 2 first-hand line cites (`launcher/watch.py`, `launcher/cli.py`, `launcher/resources.py`, `coordination/TASKS.json`). The intermittent "No permission client configured for Bash" fault recurred; every write is verified by re-read (the first heredoc landed on disk despite returning the error).

## 1. Accepted peer claims (with citations)

1. **No-timeout delivery is binding policy** — Analyst 1 §1.2 (five reasons), Analyst 3 §2 (recorded orchestrator directive).
   Accepted in full. My critique never proposed timeout-delivery. Acceptance test adopted: with the feed empty, zero wake deliveries occur; escalation routes to a known custody-bound owner (head/principal), never an unknown composer.
2. **Empty-readiness mechanism** — Analyst 1 §1.1.
   Accepted: `service.py:825` accumulates only across consecutive cycles of one `session_id`; `service.py:1217-1253` force-resets on missing/ambiguous match. Identity churn (14 `previous_ids`) therefore converts churn directly into `ready_snapshots: 0` — correct blocking policy starved by a broken feed.
3. **Roster artifact defect** — Analyst 3 §1.
   Accepted: byte-identical CURRENT copy, as_of-frozen mtime, future `claimed_as_of` 19:13:00Z vs observed 17:15:59Z, WITHHELD acceptance. I endorse scale50-E fixes 1–2 (demote unless transcript mtime ≤5 min AND `/proc/<pid>` live; regenerated views over one authoritative store; future-stamp hard validation). Accepted strictly as an *artifact* finding; the embedded lifetime inference is handled in §2.1.
4. **RAM-claim falsifications** — Analyst 3 §3 points 1–6; Analyst 4 §1 withdrawal; Analyst 5 §1–2.
   Accepted: `MemoryMax` is a cgroup ceiling, not a reservation; measured RSS (≈120–430M) contradicts the 38.4 GiB premise; no RAM-keyed admission refusal exists in evidence (the one observed hold was disk-keyed, `TASKS.json` scale50-D); the 512M drop stays withdrawn; retained containment is `MemoryMax=1500M` / `TasksMax=100`.
5. **8486acf global-halt falsification** — Analyst 5 §1.
   Accepted; matches my first-hand trace (`watch.py:83-87` — the `"global"` branch is set by no production path; `cli.py:700` default is per-task dependency gating).
6. **Payload-timeout record** — Analyst 1 §0.2.
   Accepted as recorded: cleanup fix pinned at commit `a1e3f84` (not `eb9158e` as the cross-reading states); two residual 120s stores and the missing payload-timeout regression test remain open.
7. **Store-coverage gap** — Analyst 1 §0.3.
   Accepted: `get_ql_db_candidates` scans only three of four live stores; watcher staleness threshold still 120s. This is a prerequisite for R1/R4 below.
8. **Analyst 4 §1–2 self-corrections** (superseded 10 GiB floor; ZAI cap is backend-specific occupancy).
   Accepted — in the corrected dynamic-routing form of §2.3.

## 2. Rejected / withdrawn claims (with citations and rationale)

1. **"≤48 s worker lifetime" — withdrawn, including my own Part 3 refinement 1** (phrasing in Analyst 3 §1).
   Transcript `mtime`/`latest_event_at` bound the observable *logging* window, not process lifetime; mtime ≠ lifetime. The 17:22:37Z census cannot exclude later activity or a later burst under the same or regenerated identities. What survives: the stale standing-artifact defect and the fan-out-without-per-worker-custody gap. The death mechanism returns to honest unknown; only `/proc`/cgroup accounting can settle it. (Analyst 3's own mtime-≤5 min demotion rule is unaffected: it demotes conservatively, it never asserts lifetime.)
2. **20 GiB as a RAM floor — rejected** (Analyst 5 §2 point 2; Analyst 4 §2 attributes the conflation partly to my S2.5).
   `resources.py:9-10` is `MIN_DISK_FREE_BYTES` — root-disk policy with projected growth, not memory. My S2.5 cited it as disk and the record stays disk-scoped. The human `MemAvailable` override for this initiative remains in effect; no RAM-floor arithmetic belongs in admission.
3. **Static 26+20+4 provider allocation — rejected** (Analyst 4 §3; Analyst 4 retracts it; reasons recorded here).
   The shared ZAI 26 is an atomic *occupancy ceiling* shared with other consumers, not 26 allocatable slots. The 20 (AGY/Space Bunny) and 4 (Codex) figures have no fresh measured quota basis; a Codex "reserve" contradicts the 15%-remaining gate; principal oversight does not count toward worker 50. Concurrency must route dynamically to fresh, measured, healthy tasks.
4. **Stable-tag transfer of readiness credit across restarts — rejected as written** (Analyst 1 §1.3 R3a: "so restarts … no longer reset them").
   A restart is a new generation: accumulated snapshots describe a process state that no longer exists; carrying them forward fabricates freshness — the exact churn hazard R3a targets. Analyst 3 §2 item 2 (stable actor tag **+ generation**) is already correctly scoped; no disagreement with it.
5. **Oct 5 inference from current watcher absence — my own S2.1 overreach, corrected** (challenge raised by Analyst 4 §2).
   "0 loaded units" is a current-state observation; Oct 5 standing-service status is unknown. Oct 5 head-cadence coupling remains supported by outcome evidence (dispatch cadence = accept cadence; head loss at 17:22Z), not by current absence. Repair R1 stands regardless.

## 3. Remaining technical dissents (preserved)

1. **Generation-bound, fresh readiness accumulation** — against Analyst 1 R3a's literal wording: accumulate on (actor tag, generation epoch), reset at generation change, enforce a freshness window; no wake delivery on timeout regardless of any accumulated count. Durable keys bind identity/custody — never readiness credit.
2. **R6 read-only disk-floor bypass** stays contested: the disk-keyed hold was the one empirically observed admission blocker (Analyst 3 §3.4), so loosening it even for no-write tasks requires an independent reviewer's approval; default remains gated.
3. **R8 same-head-session acceptance strictness** (scale50-21) remains open for heads that legitimately delegate; keep until a concrete counterexample forces relaxation.

## 4. Concrete next action / canonical task ID

- **Canonical task:** `scale50-D-dispatch-refill` (status ready, `ownership_ack: true`, owner quota-launcher-head-gemini).
- **First action (hours):** dump all live stores — including the fourth store omitted by `get_ql_db_candidates` — and produce the independent-ready count: substantive goal, no unaccepted deps, `ownership_ack: true`, pairwise non-overlapping paths. That count is the dynamic-routing input and the R4 backlog-contract baseline.
- **Then R1:** register `launcher watch` as a standing systemd user unit — QL-head-owned, `launch.lock` held, TEAM-REGISTRY entry with native unit ID, ≥24 h active, hourly dispatch traces, second-instance refusal proving the lock.
- **Stage proof gate (my Phase 2 panel test):** ≥1 completion→next-dispatch transition with no `accept` and no head action; an independent task dispatching while another sits `completed-awaiting-review`; zero dep-chain dispatches before dep acceptance; live `/proc`-verified roster within ±1 of claimed active.
- **Parallel:** scale50-E items 1–2 (hours-level, per Analyst 3 §4 sequencing) to make measurement truthful; scale50-21 needs owner-lease ACK or an explicit superseded-by pointer to scale50-D R1/R2 within 24 h — its day-stale checkpoint repeats the S2.4 no-successor pattern.
