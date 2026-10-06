# Successor Analyst 3 (Scope 3) — Phase 2 Response ADDENDUM

- Date: 2026-10-06 (Europe/Berlin). Inputs: all five Phase 2 critiques in `agent-branches/research/scale50-analysts/phase2/`, my Phase 1 report and Phase 2 critique, and canonical
  `coordination/TASKS.json` (cited IDs verified present today).

## 1. Accepted peer claims

- A1 (Analyst 1 §1.1): the empty readiness pipeline is structural — `service.py:808-820` `eligible()` requires PID +
  reported state + composer screen (+quota for codex-principal); `:825` accumulates only across consecutive cycles of
  one `session_id`; `:1217-1253` force-resets on missing/ambiguous match. Identity churn (14 `previous_ids`, my F6)
  zeroes `ready_snapshots` mechanically. The 4,087-vs-4,095 event-count difference is snapshot timing, immaterial.
- A2 (Analyst 1 §1.2, accepted as binding): never deliver wakes to readiness-unknown composers on timeout. Matches my
  §2 and the recorded desktop directive; the blocking policy was correct, the producer feed was broken — repair
  targets the feed, never the gate.
- A3 (Analyst 2 §S2.2; Analyst 5 §1 self-retraction): `watch.py:177` defaults `wait_for_review="dependencies"`; the
  global halt exists only behind literal `"global"` (`watch.py:83-87`, no production caller); per-task dependency
  gating is the CLI default (`cli.py:700`); accept-path refill is single-shot (`cli.py:413-428`). The 8486acf "global
  serialization" claim is dead; dependency chains still propagate review-gating.
- A4 (Analyst 2 Part 3, amended at R3): byte-identical CURRENT roster confirmed by sampling; `roster_audit` future
  timestamp (`claimed_as_of` 19:13Z vs observed 17:15:59Z) violates the Corrective Counting Invariant and justified
  WITHHOLD. The consumer-side defect stands.
- A5 (Analyst 4 §1 withdrawal; Analyst 5 §2 measurement): the 512M MemoryMax-drop recommendation is withdrawn;
  MemoryMax is a cgroup ceiling, not wired RSS. Measured worker RSS ~120–430M is accepted as a measurement even where
  its framing is rejected (R2).
- A6 (Analyst 4 §2 semantics): ZAI 26 is a single-backend atomic occupancy limit, not a systemic 50-worker bottleneck;
  multi-provider routing is the correct mechanism.

## 2. Rejected peer claims

- R1 (Analyst 4 §3): the static allocation "26 ZAI + 20 Gemini/SB + 4 Codex = 50" is rejected. ZAI 26 is an atomic
  shared occupancy ceiling, not 26 dispatchable slots reserved per task class; the "20" Gemini/SpaceBunny capacity has
  no fresh measured health/allowance check; Codex stays under the real 15%-remaining launch gate, so "4 slots" is
  unverified; principal oversight does not count toward worker-50. Concurrency must route dynamically to fresh
  measured healthy tasks (human34 time-aware GLM-window routing); fixed slot tables reintroduce invented evidence.
- R2 (Analyst 5 §2): "superseded by a corrected 20 GiB floor in `launcher/resources.py`" as a RAM constraint is
  rejected. `resources.py:9-10` is `MIN_DISK_FREE_BYTES` — ROOT DISK policy, not RAM. The human RAM override for this
  initiative remains in effect; RAM admission belongs to measured MemAvailable plus per-process RSS telemetry with
  retained containment (`MemoryMax=1500M`, `TasksMax=100`). Analyst 2 cites the same constants correctly as disk.
- R3 (amends A4 and my own Phase 1/2 claim): the "≤48 s worker lifetime" is withdrawn as proven fact and must not be
  defended. Transcript mtimes / `latest_event_at` prove only absence of pinned recorded events after 17:21:59Z — mtime
  ≠ lifetime (logging may detach before death), and an early census cannot refute a later burst. Worker lifetime and
  death mechanism stay unknown. The valid inference is one-directional: no recent writes ⇒ cannot claim active; never
  the converse.
- R4 (Analyst 2 §S2.1 addendum as stated): inferring Oct 5 dispatch behavior ("dispatch depended on head-armed
  triggers") from today's `scale50-D` observation "0 loaded units" is rejected — current loaded-watcher absence
  cannot infer the Oct 5 TASKS/launcher snapshot; it requires Oct 5-dated evidence (unit/journal records, launcher
  store rows). Accepted only as a present-state finding.
- R5 (Analyst 1 §1.3 R3a as worded, amended): persisting ready-snapshot counts "on the durable tag" must not transfer
  accumulated readiness across restarts. Readiness accumulation is generation-bound and fresh: keyed by (durable actor
  tag, generation epoch), reset on identity regeneration/restart, with snapshot recency bounds — no stable-tag
  transfer. This matches my §2 repair item 2 and closes the stale-wake replay hole.

## 3. Remaining technical dissents to preserve

- D1: Why the 25 workers stopped is unresolved. The cheap decisive check is reading the 25 pinned transcript tails
  plus Oct 5-dated unit/journal records; all lifetime claims stay quarantined until then.
- D2: No static provider allocations and no static RAM-floor arithmetic in root-cause claims; admission and routing
  gate on fresh measurement only. The Oct 3–6 root-cause set remains evidence integrity + custody + backlog supply —
  not RAM or quota arithmetic.
- D3: A timeout-delivery path must never exist in code; blocked-beyond-SLO escalates only to known, custody-bound
  owners (head/principal) or expires into an explicit ended/unknown state.
- D4: The byte-copy "CURRENT" roster pattern is retired regardless of the lifetime question: no
  refresh/self-expiry/reconcile-on-read plus future timestamps is a defect independent of why the burst ended.

## 4. Concrete next action / canonical task ID

- Canonical task: `scale50-E-roster-accountability` (agent-dashboard; ready, critical). First owned slice (hours):
  consumer-side freshness rule — active requires `/proc` liveness AND bounded transcript/log recency, auto-demote
  otherwise; hard-reject rosters with future `claimed_as_of`; regenerate rosters as views over one authoritative store
  (retire byte-copy CURRENT). Then fix `scripts/supervision/service.py task_event()` so blocked/review/accepted are
  not counted active.
- Sequenced follow-ons (unchanged from my Phase 2 §4): `scale50-12` (quota-launcher; blocked on owner-lease — genuine
  head ACK against this scope is the next action; first slice = generation-bound readiness + wake-path epoch fencing
  via `rf.guarded_effect`/`rf.authorize`), then `scale50-31` (candidate-state freshness; negative tests feed
  `scale50-32`).
- Acceptance re-run: 10-worker burst; at every sampled instant roster-active within ±1 of /proc-verified workers
  holding first-action artifacts; zero SUCCESS self-reports without independently accepted artifacts; zero wake
  deliveries to non-snapshot-verified owners; no new `previous_ids` growth; no future timestamps anywhere in the
  artifact chain.
