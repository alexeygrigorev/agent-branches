# Successor Analyst 2 — Phase 2 Critique (Scope 2: scheduling, backlog, refill, custody, timers, dispatch)

**Analyst:** Successor Analyst 2 (Scope 2), Phase 2 mutual cross-reading of the 5-analyst panel
**Date:** 2026-10-06 (Europe/Berlin)
**Input:** all five pinned drafts in `/home/alexey/git/agent-branches/research/scale50-analysts/` plus `CROSS-READING-AND-CHALLENGES.md`
**Task:** (1) emit the full Scope 2 analysis truncated by the Phase 1 environment fault; (2) answer Analyst 5's review-gating claim with a first-hand code audit of `launcher/watch.py`; (3) respond to Analyst 3's static-roster finding; (4) map concrete repairs to canonical `coordination/TASKS.json` IDs `scale50-D-dispatch-refill` and `scale50-21`.

## Method and environment-fault disclosure (read first)

This session hit the same permission-client fault Analyst 2 reported in Phase 1, in an asymmetric form. **Working:** read-only coreutils (`ls`, `grep`, `stat`, `head`, `wc`, file reads). **Failing with `No permission client configured for Bash`:** all mutating shell forms (`>` redirect, `tee`, `mkdir`), `sqlite3`, `python3`, `git`, and the harness Write tool — though at least one mutating command landed on disk despite returning the error (`.write-test`, 14 bytes), so mutation errors are unreliable in both directions and every write is verified by re-read. This file was written by shell heredoc after a spurious-error retry; store-level numbers below are cited from the panel's pinned drafts and `TASKS.json` fields rather than re-derived (sqlite blocked). Every code claim about `watch.py`, `cli.py`, `resources.py`, roster transcript mtimes and `TASKS.json` entries is first-hand and line-cited.

## Part 1 — Full Scope 2 analysis (remedying the Phase 1 truncation)

Phase 1 delivered only a summary; the five findings below are restated with the first-hand verification this session added.

### S2.1 The single serial head loop, not worker capacity, was the concurrency ceiling

Each lane ran its submit→run→review→accept→refill→re-arm cycle through one interactive head. Three failure modes collapse lane concurrency to zero: head idle (no re-arm), head blocked in a modal CLI menu (QL head, Oct 6 ~09:32), and head death (QL head lost 17:22 Oct 5 — one minute after the verified 25-worker snapshot). The one event that genuinely reached 25 workers (17:21:24Z, sha256-pinned in `.local/scale50/ROOT-25-TRANSCRIPT-EVIDENCE-20261005.json`) did so by native subagent fan-out that bypassed the serial loop entirely — and then collapsed within a minute (see Part 3), because the same design has no per-worker supervision behind the fan-out. The 50-target was never bounded by launcher admission math; it was bounded by "how many tasks one head can personally midwife."

**First-hand addendum:** the current source contains a non-LLM dispatch loop that decouples dispatch from the head — `watch_loop` (`watch.py:170-301`) dispatches one queued task per pass at a 10 s default interval (`cli.py:702`). But `TASKS.json` `scale50-D-dispatch-refill.current_observation` records `maintained_active_count: 0` and coverage "systemctl --user agent-task-* only (0 loaded units)". The loop existed in source; it was not running as a standing service. Dispatch therefore depended on head-armed triggers — the architecture failure is "loop written, loop not wired."

### S2.2 Review-gated refill: what the code actually gates (verified, supersedes Phase 1 wording)

Verified against `/home/alexey/git/agent-quota-launcher/launcher/watch.py` (301 lines, read in full this session):

- `watch.py:177`: `wait_for_review = getattr(args, 'wait_for_review', "dependencies")`.
- `watch.py:83-87`: a **global** halt on any `completed-awaiting-review` task exists only under the literal `wait_for_review == "global"`. No CLI or call site in production sets `"global"` (`tests/test_watch.py:55` is the only user). Analyst 5's headline mechanism is therefore not reachable in production.
- `watch.py:89`: `check_dependencies = wait_for_review in (True, "dependencies", "per-task")`. The `watch` CLI argparse default is `True` (`cli.py:700`, `--no-wait-review` stores False), so **per-task dependency gating is on by default**.
- `watch.py:127-144`: a queued task is blocked iff it *declares* `depends_on`/`dependencies` and any declared dep is not in state `accepted`. A dep sitting in `completed-awaiting-review` **does** block dependents — review-gating propagates through declared chains (e.g. `scale50-24` depends on `23`, `TASKS.json:4405-4407`).
- `watch.py:119-121`: tasks with an empty goal or `goal == task_id` are skipped as "bare proposal" with a recorded reason; `watch.py:123-124` skips tasks carrying an `admission:` reason. Both produce "nothing dispatchable" from outside without any explicit blocked status.
- `cli.py:413-428`: `launcher accept` triggers `watch_loop(refill_args, max_passes=1)` with `once=True, wait_for_review="dependencies"` — **exactly one additional dispatch per acceptance**, and the process exits after it.

Phase 1's claim 2 said refill "traded premature refill for starvation" and implied a broad review gate on dispatch. The precise statement: dispatch of **independent** tasks is never blocked by anyone else's pending review; dispatch of **dependent** tasks is blocked until deps are fully *accepted* (not merely completed); and the accept-path refill converts review cadence directly into dispatch cadence. Phase 1's observed symptoms — 23 tasks parked in `completed-awaiting-review`, rejections as "bare proposal", coverage falling to 0 with 30 failed / 0 queued (Oct 6 09:26) — are consistent with this code, but the binding constraint was supply of independent, substantive, acked backlog (S2.3), not the gate mechanics.

### S2.3 The backlog, not the launcher, set the concurrency bound

`TASKS.json` holds 63 `scale50*` entries; 29 are `status: blocked` and roughly 26 carry `ownership_ack: true` (line-window count; exact per-task attribution requires sqlite, blocked this session). Phase 1's claim of ~12–17 genuine ACKs among 58 slices is directionally consistent; the discrepancy range is attribution noise, not substance. A dispatch loop can only emit tasks that exist as queued rows with (a) a substantive goal (the `watch.py:119` gate), (b) no unaccepted declared deps, (c) no path overlap with a live lease (`watch.py:151-165`), and (d) passing admission. During Oct 5–6 the ready set was near-empty while heads chained work through dependency declarations — so the preserved practical dissent in CROSS-READING Challenge 2 ("the backlog frequently lacked independent ready tasks") is **confirmed**, and it is the correct replacement for Analyst 5's falsified mechanical claim.

### S2.4 Timer continuation failed because timers were head-armed one-shots

Phase 1 recorded: duplicate overlapping timers, self-cancellations before due (timer 6859), and a cancellation with no successor (Ant 12657 → ≥17 min idle → another custody recovery; 4 head recoveries on Oct 6 morning alone). These are custody-path records in `.local/supervision/events.jsonl` and mailbox transcripts that this session could not re-query (sqlite blocked); they stand as Phase 1 citations, not re-derived facts. The design defect is structural and independent of the specific IDs: a continuation trigger that requires the head to arm a one-shot timer inherits every S2.1 failure mode, and cancellation without a named successor violates the durable-continuation contract in AGENTS.md (human message 31 / fix-and-run steering).

### S2.5 Admission cliff: all-or-nothing disk gating amplified the stall (fix verified in source)

`launcher/resources.py:9-10` now carries `MIN_DISK_FREE_BYTES = 20 * 1024**3` (hard floor) and `WARN_DISK_FREE_BYTES = 30 * 1024**3` (warning) — Phase 1's "corrected 20 GiB floor now in resources.py" is verified. The history that mattered: `TASKS.json` scale50-D `prior_next_action_history` records the dispatch loop "strictly held by admission policy while root free space is 46.73 GiB (<50.0 GiB floor)" — a *dispatch* hold imposed by a floor sized for storage hygiene, during the exact window when the queue needed any useful outlet. Under the old cliff, a disk-pressure side constraint zeroed execution concurrency; the corrected two-tier design (20 GiB hard, 30 GiB single-cleanup-actor warning, per `scale50-D.next_action`) removes that coupling. Residual risk: the hard floor still gates *all* dispatch including non-writing tasks; see R6.

### Root-cause chain (Scope 2)

```
head idle/menu/death ──────────────► no re-arm, no dispatch (loop not a standing service)
        │                                      │
        ▼                                      ▼
one-shot timers cancel/die w/o successor   refill only on `accept` (once=True, max_passes=1)
        │                                      │
        ▼                                      ▼
custody recoveries (≥4, Oct 6 AM) ◄── dispatch cadence = review cadence = head cadence
                                               │
backlog: few independent ready tasks ──────────┘   (29/63 blocked; bare proposals; dep chains)
        │
        ▼
admission cliff (old 50 GiB) zeroes dispatch under disk pressure ──► coverage 0, queues starve
```

**Evidence vs unknowns.** First-hand: all watch.py/cli.py/resources.py line cites above; roster transcript mtimes (Part 3); TASKS.json scale50-21/-D/-E entries; 63/29/26 backlog counts. Cited from pinned drafts, not re-derived (store reads blocked): 23-awaiting-review figure, store failure shares, timer IDs 6859/12657, 4 head recoveries, head menu/death timestamps. Unknown stays unknown: provider tokens burned per stall episode; whether any queued-but-unsubstantive rows could have been repaired into ready tasks within existing write scopes.

## Part 2 — Response to Analyst 5's review-gating claim

**Claim under test:** "commit 8486acf introduced a strict serialization logic: if *any* task is in `completed-awaiting-review`, refill refuses to dispatch subsequent queued tasks → guaranteed 1-by-1 serial execution."

**Verdict: falsified as a mechanism, confirmed as a practical effect with a different cause.** The global halt exists only behind `wait_for_review == "global"` (`watch.py:83-87`), which no production path sets; the CLI default is per-task dependency gating (`cli.py:700` → `watch.py:89`). A queued task with no declared deps dispatches while unrelated tasks sit in `completed-awaiting-review` — traced through `_next_dispatchable` (`watch.py:113-166`): the only cross-task gates for an independent task are the goal-substantive check, admission reasons, and path-overlap against *live* leases. The cross-reading's falsification (Challenge 2) is correct, and its line references drift 4 lines from current source, consistent with the same code at a nearby revision; my cites are against the current file.

Three corrections to the record that both Analyst 5 and the cross-reading leave imprecise:

1. **Dependency chains still propagate review-gating.** `watch.py:142-144` requires dep state `accepted`; a `completed-awaiting-review` dep blocks dependents. Teams that expressed sequencing via `depends_on` (as scale50-24→23 does) experienced exactly the serialization Analyst 5 described — locally, per chain, by their own backlog choices. The gate is per-declaration, not global.
2. **The accept-path refill really is single-shot.** `cli.py:413-428` runs `watch_loop(..., once=True, max_passes=1)` per acceptance: one dispatch per review. Analyst 5's claim B ("throttled to the pace of human/independent review") is true **for this path** — it is the throughput model, not a queue lock. With no standing `watch` service loaded (`scale50-D`: "0 loaded units"), accept-triggered refill was in practice the only dispatch trigger, which is how review cadence became system cadence.
3. **"Dispatch only the next queued task" per pass is not the bottleneck.** A standing loop at the 10 s default interval allows up to 6 dispatches/minute; the watch loop was never the slow stage. Naming it the serializer (as the cross-reading's fix 4 partially does) risks "fixing" a component that already behaves correctly, while the actual constraints — no standing loop wired to completion events, plus an empty independent-ready backlog — go unowned.

**Answer to Analyst 5's preserved dissent:** yes — the backlog lacked independent ready tasks, and that, plus trigger wiring (S2.1), fully explains the observed starvation without any global gate. Both of Analyst 5's proposed fixes need amendment though: "remove the wait_for_review gate" is a no-op for production (it already doesn't bind independent tasks) and dangerous for declared chains (it would dispatch dependents past unreviewed dependencies); "refill on worker exit regardless of pending reviews" is right and is exactly what scale50-D's acceptance text already specifies.

## Part 3 — Response to Analyst 3's static-roster finding

**Finding:** `ROSTER-25-ACTIVE-WORKERS-20261005{.json,.md}` claimed 25 active workers as_of 17:21:24Z; all transcript mtimes 17:21:52–59Z; lifetimes ≤ ~48 s; the "CURRENT" roster is a byte-copy never refreshed.

**Verdict: confirmed first-hand by sampling.** Five of the 25 transcript URIs (`~/.gemini/antigravity-cli/brain/{e0b85c7a…,3c3b1392…,b17d5adf…,df99e1d4…,aa957f31…}/.system_generated/logs/transcript.jsonl`) all have final mtimes 2026-10-05 17:21:55.4–59.1 UTC — 31–35 s after the roster's as_of, and untouched in the ~20 h since. The files were never written again; the "25 active" claim described a burst that was already over when the roster was generated. Corroborating from `TASKS.json` scale50-E `roster_audit`: the roster lineage also carried `claimed_as_of: 2026-10-05T19:13:00Z` against an observation at 17:15:59Z — a future timestamp that fails the AGENTS.md Corrective Counting Invariant (authentic UTC, no future stamps) and was correctly WITHHELD (`19:13` is 17:13 UTC relabeled, i.e. the exact local-as-Z mislabel the invariant prohibits).

Two refinements from the Scope 2 seat:

1. **The ≤48 s lifetime is a Scope 2 finding, not only an evidence finding.** Workers did not die of resource exhaustion (cross-reading Challenge 1: measured RSS 364–429M, host had headroom). They stopped when the arming head's fan-out turn ended — the same S2.1 serial-loop defect viewed from below: fan-out without per-worker custody, completion callbacks, or restart. Analyst 3's honest unknown ("the exact mechanism that ended worker lives") is most plausibly answered here: nothing was tasked to keep them alive or restart them; the burst was a snapshot-length episode by construction. This remains a hypothesis until the transcript tails are read — but it is testable (see Falsification below).
2. **The byte-copy "CURRENT" file is the actionable defect.** A point-in-time artifact is legitimate evidence; relabeling it "CURRENT-UTC" without a refresh process converts evidence into a false standing claim. The repair is mechanical (self-expiring active state, reconcile-on-read — Analyst 3's fixes 1–2 are sound and I endorse them), and its canonical owner is scale50-E `roster-accountability`; the Scope 2 share is mapped in Part 4.

## Part 4 — Concrete repairs mapped to canonical TASKS.json IDs

### scale50-D-dispatch-refill (status: ready, ownership_ack: true, owner quota-launcher-head-gemini, critical)

Canonical acceptance already says: "Automated completion-to-refill single-pass non-LLM watch loop in wt-refill-runtime dispatches next admitted task upon task exit 0 when queue is populated and admission gates pass." The gap between that text and the observed "0 loaded units" is wiring and proof, not design. Repairs, in order:

- **R1 (D-1) Make the loop a standing, owned unit.** Run `launcher watch` (default per-task dependency gating) as a named systemd user unit with `launch.lock` held, owned by the QL head, registered in TEAM-REGISTRY with native unit ID and first-action evidence. Verification: unit loaded and active for ≥24 h; ≥1 dispatch trace per hour of queue occupancy; zero duplicate concurrent watchers (lock proven by second-instance refusal). This directly discharges the "0 loaded units" observation.
- **R2 (D-2) Completion-triggered refill, not accept-triggered only.** On task exit 0 / native death reconciliation (`_reconcile`, `watch.py:31-52`), the running loop naturally refills on its next 10 s pass — the repair is to prove it: one seeded test task completes → next queued task dispatches with no `launcher accept` invocation and no head action. Keep accept-path refill unchanged; it is a subset behavior.
- **R3 (D-3) Regression tests that lock in the Analyst 5 falsification.** Add to `tests/test_watch.py`: (a) task B queued+independent while task A sits `completed-awaiting-review` → B dispatches under CLI-default `wait_for_review=True`; (b) B declaring `depends_on: [A]` stays blocked while A is `completed-awaiting-review` and dispatches after `accept_task(A)`; (c) an empty-goal row is skipped with a recorded reason and never counted "dispatchable"; (d) dispatch emits a task-local TMPDIR under `<cwd>/.local/tmp` (`watch.py:55-70`). These prevent both regression directions: a future global-gate reintroduction *and* a careless gate removal that breaks dependency chains.
- **R4 (D-4) Backlog supply contract.** The loop is only as useful as the ready set. Before each stage ramp (10→25→50), require: ≥ N independent queued rows with substantive goals, no unaccepted deps, explicit `ownership_ack: true`, and write scopes that pairwise don't overlap (`watch.py:151-165` will enforce; pre-check anyway). Backlog repair (converting bare proposals into substantive goals within owned scopes) is the prerequisite work item; if the ready set is empty, record `blocked: backlog-empty` with next owner — do not manufacture filler (AGENTS.md prohibition).
- **R5 (D-5) Stage evidence under the corrected floors.** Use the now-verified 20 GiB hard / 30 GiB warn tiers in `resources.py:9-10`; record per stage: concurrent ACTIVE workers (distinct actor/provider/session/generation), first-action artifacts, failed/cancelled, unknowns — never a count from a static roster (Part 3).
- **R6 (D-6, optional hardening)** Let purely read-only/no-write tasks bypass the disk hard floor with an explicit annotation, so storage hygiene can never again zero execution (the 46.73 GiB hold failure mode); default remains gated.

### scale50-21 (status: blocked, ownership_ack: false, deps [owner-lease], due_checkpoint stale at 2026-10-05T11:15Z)

Canonical acceptance: "genuine distinct head consumes own reply and starts next useful task without principal/root poke." This is the head-completion callback that makes the system event-driven instead of poll/accept-driven. Repairs:

- **R7 (21-1) Unblock the task itself first.** It has sat `blocked` with `ownership_ack: false` and a day-stale checkpoint. Named owner (codex-principal as recorded owner_tag) must either re-offer allocation to a concrete head within 24 h or mark it superseded-by-scale50-D-R1/R2 with a pointer — a task blocked on a dependency ("owner-lease") that no one is actively brokering is exactly the S2.4 no-successor pattern at the task level.
- **R8 (21-2) Define the callback mechanically so "genuine" is testable.** On completion of a head-owned task, the head process (not the principal, not root, not the launcher alone) consumes the result artifact and submits/re-arms the next owned task, evidenced by: distinct head session ID on both the consume and submit actions, first tool call of the successor task within the same head session, and no principal/root message in between. One passing demonstration per head counts as acceptance; a scripted stub does not.
- **R9 (21-3) Replace head-armed one-shot timers with supervisor-owned periodic wake.** The head's continuation duty becomes "hold a registered periodic wake" (existing supervision wake path) rather than "remember to re-arm a timer." This retires the 6859/12657 failure class; the wake owner is the supervision service, so a dead head leaves a detectable wake gap rather than silent expiry.
- **R10 (21-4) Custody handoff on head death.** Register, per head, a recovery cursor (owned tasks, last artifact, next action) at a path the QL/dashboard side can read; on head loss (QL head 17:22 Oct 5 class of event), recovery is a bounded re-registration, not a from-scratch custody hunt. Pairs with Analyst 3's reconcile-on-read fix.

Adjacent, not owned here: **scale50-E-roster-accountability** should consume Part 3 — self-expiring active state (transcript mtime ≤ 5 min), /proc reconcile, and prohibition of byte-copy "CURRENT" rosters; the panel's fixes 1–2 and falsification test are adequate as written.

### Panel-level verification (falsification test for the combined repair)

Re-run the staged ramp to 10 workers with R1–R5 active. Pass requires, at every sampled instant: (1) standing watch unit active with lock; (2) at least one completion→next-dispatch transition with no `accept` and no head action in the interval; (3) roster "active" within ±1 of /proc-verified workers with first-action artifacts, sampled live, not retro-labeled; (4) an independent queued task dispatching while another task sits `completed-awaiting-review`; (5) zero dependency-chain tasks dispatching before dep acceptance. Any violation fails the stage and holds the ramp.

## Unknowns (truthful)

- Launcher SQLite stores were not re-queried this session (environment fault): the 23-awaiting-review figure, per-store failure shares, and the current queued-independent count are cited, not re-derived. First action for scale50-D R4 is precisely that store dump by an able session.
- Timer-event specifics (6859, 12657, 4 head recoveries) are Phase 1 citations; the mailbox/event logs were not re-read here.
- Token/cost burn of stall episodes: unknown, stays unknown.
- The ≤48 s worker-death mechanism (Part 3) is a hypothesis consistent with all pinned evidence; reading the 25 transcript tails would confirm or kill it and is cheap.

— Successor Analyst 2, independent. Peers should challenge: (a) my claim that the standing `watch` loop at 10 s interval was never the throughput bottleneck (R3a would falsify); (b) the R6 read-only-bypass proposal, which loosens a safety floor and needs an independent reviewer's eyes; (c) whether R8's "same head session" requirement is overly strict for heads that legitimately delegate.
