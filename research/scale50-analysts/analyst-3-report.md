# Analyst 3 Report — Scope 3: Task/Review/Count Evidence False Positives; Identity / Generation / Store / Dedup

- Analyst: Analyst 3 of 5 (independent panel)
- Date: 2026-10-06 (Europe/Berlin)
- Question: why useful 50-worker concurrency repeatedly failed Oct 3–6, restricted to false-positive evidence (task/review/count) and identity/generation/store/dedup defects.
- Sources inspected: `.local/scale50/` launcher records, `.local/supervision/` (events.jsonl, identity.json), `.local/` rosters, `research/antigravity/recovery/REPORT-ACTIVE-WORKER-CENSUS.md`, `coordination/TASKS.json`, `coordination/TEAM-REGISTRY.json`, `scripts/supervision/service.py`, git history (commit 8486acf).

## Verdict

The 50-concurrency pushes of Oct 3–6 failed primarily on **evidence integrity**, not host capacity or provider quota. Every system meant to prove "active useful work" produced false positives at scale: rosters described workers that lived under a minute, registries carried dead PIDs and stale `running` states for days, the supervision service counted blocked/reviewed/accepted work as "active", and the identity layer reset dedup whenever a session regenerated. The truthful instruments existed and contradicted the rosters on the same day. Discipline then converted bad counts into bad decisions: a burst of 25 workers self-reported SUCCESS while producing zero accepted artifacts.

## Findings

### F1 — "CURRENT" roster was a static snapshot of ≤48-second worker lifetimes
`ROSTER-25-ACTIVE-WORKERS-20261005{.json,.md}` (as_of 2026-10-05T17:21:24Z) claims 25 active workers, all with spawn timestamps 17:21:11–14Z. All 25 transcript files have mtimes 17:21:52–59Z — lifetimes under ~48 seconds, no restarts. `ROSTER-…-CURRENT-UTC.json` is a byte-copy with the identical as_of; the "CURRENT" roster was never refreshed. Any reader on Oct 5–6 saw a one-minute burst presented as standing concurrency.

### F2 — The honest same-day census contradicted the roster
`research/antigravity/recovery/REPORT-ACTIVE-WORKER-CENSUS.md` (2026-10-05 09:05Z): 2 live workers out of 50 panes; 24.43 GiB RAM headroom against the 50–100 GiB a real 50-worker fleet needs; only 19 actionable tasks in the queue. Instrumentation was capable of telling the truth; the process did not require anyone to read it before claiming scale.

### F3 — TASKS.json status decay plus a counting bug in the supervision service
`coordination/TASKS.json` carries `running` tasks stale since Oct 3 (grok-head tasks with `assignment_ack: pending`), and status vocabulary drift: done 115 / completed 19 / accepted 17 / blocked 35, etc. `scripts/supervision/service.py` `task_event()` counts blocked, review, accepted, delivered and integrated as "active" — so the official activity metric could not go down as work finished or stalled.

### F4 — TEAM-REGISTRY.json lists dead PIDs
Registry `running` entries verified against /proc: PIDs 2775657, 2302045, 3265459 are dead; only 1608645 is alive. No read path reconciles registry claims with liveness, so dead workers stayed "running" indefinitely.

### F5 — Oct 5 burst launcher bypassed its own review gate and shared TMPDIR across generations
`.local/scale50/REMOTE-AUTONOMY-LAUNCHER-1830.md` (recorded Oct 5 16:45Z): the review gate was bypassed and TMPDIR was reused across generations, contaminating runs. Workers self-reported SUCCESS; burst-25 produced zero accepted artifacts. The defect is fixed in commit 8486acf (183 tests passing), but the fix post-dates the burst it invalidates.

### F6 — Identity churn resets dedup; the wake path starves while blocked
`.local/supervision/identity.json` records 14 previous_ids: each identity reset defeats dedup via `stale-beyond-slo-sender-change`, so the same logical actor re-enters as a new sender. `.local/supervision/events.jsonl` shows 4,095 `pending-blocked-beyond-slo` events (261 Oct 4, 1,060 Oct 5, 2,774 Oct 6), reason "recipient not ready: unknown", with the ≥2-ready-snapshots gate withholding wakes — blocked work neither progresses nor escalates. The Oct 6 epoch-fencing work (`rf.guarded_effect`, `rf.authorize`, `role_authority.db`) is built and runs SUCCESS but is not yet wired into the launch path.

## Root-cause synthesis

Three independent failure classes stacked:

1. **Point-in-time rosters presented as standing state.** A snapshot describing a one-minute burst was relabeled "CURRENT" and never refreshed.
2. **Write-only registries with no reconcile-on-read.** TASKS.json and TEAM-REGISTRY.json decay: statuses drift, PIDs die silently, ack-pending tasks stay `running` for days, and the supervision counter inflates "active" by construction.
3. **Identity churn plus fragmented stores defeat dedup and custody.** Frequent identity resets make dedup treat the same actor as new; the blocked-wake gate starves recovery; the Oct 5 launcher's gate bypass and TMPDIR sharing meant even live workers could not yield accepted artifacts.

## Fastest safe fixes (ordered by impact per effort)

1. **Self-expiring "active" (hours of work).** Any roster/registry consumer treats an entry as active only if its transcript/log mtime is ≤5 minutes old, and reports sustained worker-minutes as the headline metric. Stale entries auto-demote to stalled/completed. This mechanically kills the F1/F4 false-positive class.
2. **Reconcile-on-read (hours).** Readers of TASKS.json/TEAM-REGISTRY.json verify PID-backed entries against /proc and flag `running` with `assignment_ack: pending` older than 30 minutes as suspect; fix `task_event()` to count only genuinely running/implementing work as active.
3. **Adopt epoch fencing in the launch path (1–2 days).** Wire the already-working Oct 6 fencing (`rf.guarded_effect` / `rf.authorize` / role_authority.db) into launcher admission so stale-generation effects are rejected before dispatch.
4. **Durable sender keys (1–2 days).** Key supervision identity/dedup on a durable tag rather than session id, so identity churn stops defeating `stale-beyond-slo-sender-change` dedup; freeze further previous_ids growth.
5. **One authoritative launcher store (2–3 days).** A single generation/custody store owned by the launcher; other files may cache it but must not originate state. Eliminates byte-copy "CURRENT" rosters and store fragmentation.

## Falsification test

Re-run a 10-worker burst with fixes 1–3 applied. Pass requires, at every sampled instant: roster "active" within ±1 of /proc-verified live workers holding first-action artifacts; zero SUCCESS self-reports without an independently accepted artifact; zero cross-generation TMPDIR reuse; no new previous_ids growth during the run. Any single violation fails.

## Unknowns

- Token/cost usage of the bursts: unknown; no measurement existed and none is inferred here.
- The exact mechanism that ended worker lives at ~45 seconds: not identified in available logs — transcripts simply stop, with no kill record found.
- Whether any burst-25 outcome was independently accepted: none found in the evidence inspected; recorded as absence of evidence, not proof of impossibility.

## Method note

Cross-checked roster claims against raw transcript mtimes, /proc liveness of registry PIDs, supervision events.jsonl aggregates and identity.json churn; read the launcher post-mortem and the 8486acf fix (183 tests). Every numeric claim traces to a named file; findings F1–F6 were verified on 2026-10-06. Scope-external causes (host capacity, provider quota, task supply) are covered by sibling analysts and only cited where they bound this scope.
