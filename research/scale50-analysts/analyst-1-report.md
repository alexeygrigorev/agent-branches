# Analyst 1 — Scope 1: controller / state-store / import / config / cleanup timeout / cooldown / restarts

Panel: independent 5-analyst failure analysis, Oct 3-6 2026 scale-50 concurrency failures.
Author: Analyst 1 (scale50-failure-analysis-20261006-1, GLM-5.3-Flash task unit via maintained launcher).
Written: 2026-10-06 ~14:50 Europe/Berlin. All DB clock strings below are as stored (naive, host clock).

## TL;DR

Useful 50-concurrency failed in Scope 1 for one dominant, now-proven reason and two reinforcing controller defects:

1. **Model-backed task units were given a 120s wall clock while the smallest possible real unit takes >170s.** Disk-pressure cleanup units ran with `timeout=120`; a single trivial Gemini 3.1 Pro turn (the cleanup unit's real runtime shape) measured **173.1s** in its own telemetry. Result: deterministic SIGKILL at ~123s -> `failed` -> 300s cooldown -> re-enqueue, for **45+ episodes in one store alone**. The fix (120->600s) landed 2026-10-06 between 12:19 and 12:24 and episodes 43-45 immediately completed. Two other stores still hold 120s-timeout cleanup records.
2. **The supervision restart controller kills the supervisor on the same pathological bound**: `status.json` older than **120s** triggers `systemctl --user restart`. Under load, supervision cycles lengthen (mailbox-lock contention, multi-DB scans) -> stale status -> mid-cycle kill -> new sessions contending on the single aplexer mailbox lock -> fail-closed `AckUncertain` errors clustered exactly in the restart windows (14 service starts on Oct 6; 3 within 65s at 07:43-07:44).
3. **The readiness snapshot pipeline was empty** (`ready_snapshots: 0` in 2,768 Oct-6 `pending-blocked-beyond-slo` events), so the controller blocked sends to "unknown" recipients beyond the 300s SLO instead of delivering — the queue-observing side reported `launcher-queue-drained` 2,028 times on Oct 6 while three other live stores held queued tasks.

Net effect across Oct 4->5->6: `pending-blocked-beyond-slo` 261 -> 1,060 -> 2,768; failed task mass concentrated in four fragmented state stores (33-63% failed per store).

## Findings with evidence

### F1. Cleanup 120s vs 600s — proven, with the exact fix point

- Launcher DB `/home/alexey/git/agent-quota-launcher/.local/state.db`, table `tasks`:
  - `disk-pressure-cleanup-40` created 12:11:20, failed 12:13:23 (**+123s**), payload `timeout=120`
  - `-41` 12:14:14 -> failed 12:16:17 (+123s), `-42` 12:17:14 -> failed 12:19:17 (+123s) — all `timeout=120`
  - `-43` 12:24:31 -> completed-awaiting-review 12:26:51 (**+140s, timeout=600**); `-44`, `-45` completed at 600s the same way.
  - The ~5-minute gap 42->43 matches `--cleanup-cooldown-sec` default 300 (`launcher/cli.py:705`, `launcher/watch.py:228`).
- Real runtime proof: `disk-pressure-cleanup-44-telemetry.jsonl` (repo root) `result.duration_seconds = 173.1` for a run that **pruned nothing** ("no files were pruned"). A 120s budget cannot fit even a no-op turn.
- Independent verification receipt `.local/recovery/ql-review-c2819-independent-verification-20261006.json`: `cleanup24 failed 11:31:52 timeout120s`, `cleanup25 starting 11:32:40 actualpayloadtimeout120` — the treadmill also ran in the morning session.
- The Oct 5 acceptance review `research/antigravity/reviews/REV-QL-BELOW30G-CLEANUP-INTEGRATION-20261005.md:21,33` explicitly ACCEPTED `timeout 120` — acceptance was based on fake-resource-probe fixture tests (`test_disk_pressure_29_gib_eligible_continues_and_cleanup_enqueued`), never a real provider-backed run. Review-quality root cause: **passing scaffold != runtime viability** (the exact anti-pattern AGENTS.md warns about).
- Code state: `launcher/watch.py:15` now has `DEFAULT_CLEANUP_TIMEOUT_SEC = 600` and `CLEANUP_PAYLOAD["timeout"]=600`; `watch.py:250` overrides only if `--cleanup-timeout` is passed. Source is fixed; see F4 for stores still carrying 120s records.
- Scale of waste: episode numbers reached 45 in one store; 12 cleanup telemetry captures sit at repo root; each failed episode consumed a full model run (episode 44 alone: ~140k input + ~10k output tokens) with zero useful output.

### F2. Restart churn — controller kills a healthy-but-busy supervisor

- `scripts/supervision/systemd/supervision_watcher.sh`: restarts when `status.json` age `> 120`s — the same 120s bound as F1, applied to a service whose cycle legitimately exceeds 120s under load.
- `.local/supervision/events.jsonl`: `service-started` 33 times total (Oct 3: 7, Oct 5: 8, Oct 6: 14), including 07:43:21, 07:43:51, 07:44:26 — three starts in 65 seconds, and another burst 08:28:35-08:29:51. New session ids each time => no single-writer latch; the oneshot unit + external aplexer session means a restart orphans the previous mid-cycle run.
- Every restart re-reads `state.json`, re-scans TEAM-REGISTRY/TASKS and re-ingests **three** launcher DBs (`scripts/supervision/service.py:372-392`) — restart itself adds seconds-to-minutes of load, worsening the staleness that triggered it.

### F3. Mailbox lock contention and fail-closed acks

- 26 `AckUncertain` events, all "mailbox ... busy, retry: lock .../.mailbox.lock: Resource temporarily unavailable", clustered Oct 6 in the same windows as the F2 restart bursts. The ack path is deliberately single-invocation, no retry (`degraded: true, incomplete-cycle`), so contention converts directly into degraded cycles and unknown ack outcomes — more pending, more SLO breaches, longer cycles (feedback into F2).

### F4. State-store fragmentation — four live stores, supervision sees three

- Live state DBs observed written within the last hour: `~/.config/agent-quota-launcher/state.db` (38 tasks, 7 queued), `agent-quota-launcher/.local/launcher-config/state.db` (97 tasks, 33 failed), `agent-quota-launcher/.local/state.db` (57 tasks, 36 failed = 63%), `agent-quota-launcher/.local/scale50/wt-gemini-head/.config/ql/state.db` (33 tasks).
- `get_ql_db_candidates` (`service.py:388-392`) scans the latter three — **not** `~/.config/agent-quota-launcher`, which is the config dir the maintained launcher actually used to run today's task units (my own unit included).
- Per-store dedup keys: `watch.py` checks `idempotency_key LIKE 'disk-pressure-cleanup-%'` only within its own DB, so independent episode numbering collided across stores (`cleanup-4` exists in two stores; `cleanup-1..3` in wt-gemini-head with `timeout=120`, still `starting`/`failed`).
- Symptom metrics: `launcher-queue-drained` 2,418 total (0 Oct 3-4 -> 390 Oct 5 -> 2,028 Oct 6) while queued tasks sat in unscanned stores.

### F5. Readiness snapshot pipeline empty — sends blocked beyond SLO

- `pending-blocked-beyond-slo` 4,087 events; daily 261 -> 1,060 -> 2,768 (Oct 4->6). Sample blocking_reason: `"recipient not ready: unknown (composer: unknown, ready_snapshots: 0)"` — the readiness feed the controller needs was never populated, so policy-correct blocking became a delivery outage. This is the largest single event class and matches "no healthy team should wait" failures seen from the outside.

### F6. Import/config errors and binary gate (bounded, minor)

- `failover-error` x2 on Oct 6: `No such file or directory: './launch.sh'` (07:56:28, cwd-relative path) and `No module named 'scripts.supervision'` (08:29:32, module path imported from wrong cwd) — `scripts/supervision/failover_integration.py` tick run outside the canonical WorkingDirectory.
- Oct 3 03:41-03:47: `scoped binary changed: re-review and restart service explicitly` fired every ~60s for 6 minutes — the binary-manifest gate turned a routine CLI upgrade into a ~6-minute oversight gap requiring a manual restart.

## Root-cause chain (scope 1)

```
real model unit needs >170s  -->  120s payload timeout  -->  deterministic SIGKILL-fail
        ^                                                    |
        |                                                    v
   300s cleanup cooldown <----------------------------- re-enqueue treadmill (45+ episodes, quota burned)
load lengthens supervision cycle --> status.json stale >120s --> watcher restart mid-cycle
        ^                                                    |
        |                                                    v
AckUncertain (mailbox lock, fail-closed) <--- duplicate/orphan supervisor sessions
        |
        v
longer cycles, SLO breaches (ready_snapshots: 0 blocks sends) ---> back to cycle lengthening
```

The 50-concurrency target was never reached not because workers could not be launched, but because the control plane's own time bounds (120s x2) and its readiness/store visibility were mis-scaled to the real runtime of the work it supervises.

## Evidence vs unknowns

**Evidence (pinned):** all F1-F6 records cited above with file paths, timestamps and DB rows; events.jsonl (8,961 lines, no rotated archives present in that dir) covers Oct 3 03:41 -> Oct 6 14:46.

**Unknowns (truthful):**
- Which process/version ran each store's watcher at each hour (no journalctl access from this sandbox; the 120->600 source commit in agent-quota-launcher could not be pinned from here — git execution outside the workspace was denied).
- Whether any **useful-work** (non-cleanup) units also died on timeout bounds in the launcher-config store (`cli.py:188` falls back to 300s when payload omits timeout — still marginal vs real turn latencies; no per-task evidence pulled).
- Total provider quota burned by the cleanup treadmill (extrapolable from episode-44 token usage x ~45 episodes, but not summed; unknown stays unknown).
- Whether AckUncertain caused real message loss (fail-closed design makes outcome unknowable by construction; recorded as degraded/unknown, not as loss).
- events.jsonl coverage before Oct 3 03:41 (archive location unverified).

## Fastest safe fix (ranked; 1-2 already validated by today's data)

1. **Keep and codify the 600s cleanup fix** (validated: episodes 43-45 completed after the change). Make unit timeouts provider-aware minimums (antigravity units >=600s), and add a regression test asserting the enqueued payload timeout for real-provider cleanup units so a fixture-only review cannot re-ship 120s. Owners: QL head + independent reviewer. Risk: near zero (already in source; align stores).
2. **De-latch the restart loop**: raise `supervision_watcher.sh` staleness threshold 120s -> 600s and require two consecutive stale observations; heartbeat `status.json` at cycle *start* as well as end; skip restart if a live `experiment-supervision` session holds the lock (extend the existing tethered-session check in `launch_supervision.sh`). Risk: low — worst case slower detection of a genuinely dead supervisor.
3. **Fix the readiness feed**: populate `ready_snapshots` (composer) or, after SLO expiry, deliver with an explicit `readiness-unknown` annotation instead of blocking forever. This converts the 2,768/day breach class into normal delivery. Risk: low; policy intent (truthful readiness) preserved by the annotation.
4. **Consolidate launcher stores**: name `~/.config/agent-quota-launcher` canonical or add it to `get_ql_db_candidates`; namespace dedup keys per store or disable cleanup enqueue in non-canonical stores (stop the duplicate `cleanup-N` series). Risk: medium — needs head-owned migration decision; do the duplicate-disabling half first.
5. **Bounded config repairs**: absolute path for `./launch.sh`; fix failover-tick import to run under the canonical WorkingDirectory; make the binary-changed gate re-arm via a recorded re-review receipt instead of manual restart.

**Verification criteria:** zero new cleanup episodes failing at ~120s; service-started rate <3/day with no co-occurring AckUncertain burst; `pending-blocked-beyond-slo` <50/day; `launcher-queue-drained` emitted for exactly one canonical store; failed-task share per store <10% over a 24h window.

— Analyst 1, independent; peers should challenge the F5 root-cause split (readiness feed vs deliberate policy) since it borders Scope 3's identity/readiness territory.
