# Analyst 3 — Phase 2 Critique (Scope 3: evidence false positives; identity/generation/store/dedup)

- Author: Successor Analyst 3, Phase 2 mutual cross-reading, 5-analyst scale-50 panel.
- Date: 2026-10-06 (Europe/Berlin). Inputs: the five pinned draft reports in
  `agent-branches/research/scale50-analysts/`, `CROSS-READING-AND-CHALLENGES.md`, and the canonical
  `coordination/TASKS.json` entries `scale50-E-roster-accountability`, `scale50-12`, `scale50-31`.
- Method: every claim below re-verified against pinned artifacts on 2026-10-06 where a check was
  possible from this environment (roster bytes, transcript evidence, TASKS.json entries,
  RESOURCE-POLICY text, supervision event counts). Re-verification results are stated explicitly.

## 1. Defense: the "CURRENT" 25-worker roster is a static snapshot of a ≤48-second burst, never refreshed

Re-verified evidence (Phase 2, Oct 6):

- `cmp` confirms `.local/scale50/ROSTER-25-ACTIVE-WORKERS-20261005.json` and
  `.local/scale50/ROSTER-25-ACTIVE-WORKERS-CURRENT-UTC.json` are **byte-identical**. The CURRENT
  copy's mtime equals its `as_of` instant (2026-10-05T17:21:24Z). It was written once and never
  refreshed; no regeneration mechanism ran before or after.
- `ROOT-25-TRANSCRIPT-EVIDENCE-20261005.json` (sha256 `baff8e25…`, checked_at 17:22:37Z): all 25
  actors have `first_tool_at` in 17:21:11–14Z and `latest_event_at` in 17:21:50–59Z. The entire
  observable activity window of the whole fleet is **≤48 seconds**; zero transcript events exist
  after 17:21:59Z for any of the 25 ids.
- Therefore any reader from 17:22Z Oct 5 onward — including every Oct 6 consumer — was shown
  "25 active workers" describing a burst whose last observable event predated the read by up to
  ~21 hours. That is the false-positive class my Scope 3 exists to catch.
- Independent corroboration from the canonical registry:
  `TASKS.json → scale50-E-roster-accountability.roster_audit` records that at observed_at
  2026-10-05T17:15:59Z the roster already claimed 25 rows with `claimed_as_of`
  2026-10-05T19:13:00Z — a **future timestamp** — mixing 8 `completed` and 1
  `completed-awaiting-review` rows into a file titled ACTIVE-WORKERS; acceptance was WITHHELD with
  a recorded correction_request. Timestamp incoherence and state-mixing predate and surround the
  burst; the artifact was never made coherent afterward.

Anticipated counter-arguments, answered:

- *"The 25 snapshot was sha256-pinned and accepted."* I accept `verified_25_milestone` as a
  point-in-time receipt (25 distinct ids, 7–13 tool events each — re-verified above). That is
  precisely the defect: an honest point-in-time milestone was relabeled CURRENT standing state.
  The same TASKS.json entry honestly records `current_count_boundary`: fleet UNKNOWN after the
  17:22Z head runtime loss. The milestone never licensed a standing roster.
- *"Mtimes could have been tampered with."* No tampering evidence exists; two byte-identical files
  with as_of-frozen mtimes is the simpler explanation. Either way the consumer-side defect — no
  self-expiry, no refresh, no reconcile-on-read — stands independent of why the workers died at
  ≤48s (mechanism still unknown, recorded as such in Phase 1).
- *"Readers understood snapshot semantics."* The file is named CURRENT-UTC and was cited as the
  standing 25-concurrency baseline in Oct 6 coordination. The misrepresentation is in the
  artifact's presentation, not reader error.

Falsification test for my own claim: produce any roster refresh event, any transcript event after
17:21:59Z for these 25 ids, or evidence of a consumer-side expiry rule in force Oct 5–6. The
pinned evidence contains none of the three.

## 2. Supervisor wake messages must NEVER be delivered on timeout to unknown composers

Evidence base: `pending-blocked-beyond-slo` totaled 4,095 at my Phase 1 read (261 → 1,060 → 2,774
over Oct 4→5→6) and **4,097 at my Phase 2 re-read** — the class is still growing live. Blocking
reason throughout: `recipient not ready: unknown (composer: unknown, ready_snapshots: 0)`.

Why timeout-delivery is categorically wrong, not merely risky:

1. **Readiness is an identity claim, not a latency value.** "Unknown composer" means the system
   cannot bind the recipient to a verified live owned session (PID-backed, first-tool evidence,
   custody). A timeout does not manufacture that binding; delivering anyway fabricates the exact
   fact the gate exists to protect.
2. **It violates explicit operating rules.** AGENTS.md: never interrupt a busy pane, never invent
   readiness; respect busy/draft/NOTREADY states. The desktop orchestrator's recorded direction in
   CROSS-READING-AND-CHALLENGES.md (Challenge 3) is categorical: "NEVER deliver to
   readiness-unknown composer based on timeout/annotation; repair genuine feed/ownedqueue/custody
   respecting busy/drafts/NOTREADY." I adopt that as binding and reject Analyst 1's F5 remedy
   ("deliver with readiness-unknown annotation after SLO expiry") as a fail-open conversion of a
   fail-closed property.
3. **Custody accountability.** A wake delivered to an unknown composer has no owner for its
   outcome; its failure re-enters the unknown bucket, compounding the 2.7k/day breach class while
   delivery counters look like progress — the same false-positive pattern as Section 1.
4. **Identity-churn interaction.** `identity.json` carries 14 `previous_ids` (pinned Phase 1);
   dedup already treats regenerated sessions as new senders (`stale-beyond-slo-sender-change`).
   Timeout-delivery plus churn means stale wakes replay at regenerated identities with no
   generation check — an unfenced effect on the message path. The Oct 6 epoch-fencing work
   (`rf.guarded_effect`, `rf.authorize`, `role_authority.db`) exists because unfenced effects are
   unsafe; a timeout-delivery rule would institutionalize one.

Required composer feed repair (producer side — the consumer's blocking was policy-correct):

1. The composer emits readiness snapshots **only** from verified sources: PID-backed live session
   plus genuine current activity (tool-event recency), with explicit states
   ready / busy / draft-protected / NOTREADY and current UTC timestamps. `ready_snapshots` is
   never synthesized from timeout age.
2. Queued recipients bind to **durable identity keys** (stable actor tag + generation, not session
   id) so "unknown" resolves to either a live owner or an explicit ended/unknown category with
   timestamps — exactly the acceptance written into `scale50-12`.
3. Blocked-beyond-SLO must **escalate, never convert**: re-address to the owning head, surface to
   principals, or expire into an explicit ended/unknown state. Delivery stays gated on
   snapshot-verified owners.
4. Wire the already-working epoch fencing into the wake path so stale-generation wakes are
   rejected before dispatch.

Acceptance test: with the feed empty, blocked events may persist or escalate but **zero** wake
deliveries occur; with the feed repaired, `ready_snapshots > 0` and deliveries occur only to
snapshot-verified owners.

## 3. Critique of Analyst 4 and Analyst 5 RAM claims

Their shared claim: 50 × 768M = 38.4 GiB > 36.17 GiB MemAvailable ⇒ the "mandatory" 10 GiB floor
is violated ⇒ OOM/admission block ⇒ failure is mathematically guaranteed; fix = drop MemoryMax to
512M. Six falsifications:

1. **The 10 GiB floor is superseded for this initiative.** RESOURCE-POLICY.md lines 70–75: for
   this scaling initiative, "do not refuse dispatch solely on MemAvailable < 10 GiB", with
   retained containment `MemoryMax=1500M / TasksMax=100`. The same invalidation is recorded in
   TASKS.json (`scale50-E` `current_policy_constraint_note`: "Older 50GiB/10GiB/max15/impossible31GiB
   next-action assumptions invalidated"). A rule explicitly waived for exactly this push cannot be
   its root cause.
2. **MemoryMax is a ceiling, not a reservation.** cgroup v2 `MemoryMax` bounds usage; it does not
   wire or reserve memory. Their arithmetic books the ceiling as allocated RSS, inflating the
   "requirement" by every worker's unused headroom.
3. **Measured RSS contradicts the premise.** Pinned cross-reading measurements: real GLM
   task-unit peak RSS 429M / 380M / 364M (Analysts 1–3 units) and ~120–180M for Python worker
   units ⇒ ≈12.5 GiB at 50 workers against 36.17 GiB available. My Phase 1 F2 census (Oct 5, 2
   live workers) measured 24.43 GiB free — the host was nowhere near exhaustion while workers
   actually ran.
4. **No RAM-keyed admission block exists in the evidence.** Both analysts cite the same
   `REMOTE-AUTONOMY-LAUNCHER-1830.md` checkpoint — a coordination log, not host telemetry — and
   neither cites one admission refusal or OOM keyed on RAM. The one empirically documented
   admission hold is **disk**-keyed (wt-refill-runtime: held at root 46.73 GiB < 50 GiB floor,
   later corrected to the 20 GiB hard projected-growth gate). The observed blocker was disk.
5. **The Oct 5 25-burst actually ran** (sha256-pinned milestone, re-verified in Section 1) —
   inconsistent with "RAM mathematically guarantees failure". The burst failed on custody and
   evidence integrity (my F1/F5), not memory.
6. **Their fix contradicts their own premise.** If 512M satisfies the "mandatory" floor with
   10.57 GiB margin, the floor was satisfiable all along at measured RSS with no profile change.
   Neither analyst engages the operative controls that govern admission today (20 GiB hard
   projected-growth gate, 30 GiB cleanup warning), and 512M conflicts with the retained 1500M
   containment policy.

Preserved merit: staged ramp with live RSS monitoring is right; multi-provider routing under the
fixed ZAI-26 shared ceiling matches RESOURCE-POLICY line 99. The error is presenting a superseded
floor plus ceiling-as-RSS arithmetic as the root cause of Oct 3–6.

Additional note on Analyst 5: the panel (Challenge 2) already falsified their primary claim —
commit 8486acf's `wait_for_review` default is `"dependencies"` (dependency-scoped gating), not a
global halt; the `"global"` branch they cite is not the default path. Their report also repeats
Analyst 4's RAM text verbatim rather than measuring — copy-through, not evidence — which lowers
its independent evidentiary weight.

## 4. Concrete repairs mapped to canonical TASKS.json IDs

### scale50-E-roster-accountability (oversight / agent-dashboard; status ready, critical)

Natural home for the Section 1 defense. Repairs:

1. **Self-expiring active (hours).** Every roster consumer treats an entry as active only if its
   transcript/log mtime ≤ 5 minutes AND `/proc/<pid>` liveness holds; otherwise auto-demote to
   stalled/ended with a demotion timestamp. Kills the F1/F4 false-positive class mechanically.
2. **Retire the byte-copy CURRENT pattern.** Rosters become regenerated views over one
   authoritative store, never hand-copied snapshots; each emission records producer, as_of and
   sha256; consumers reject rosters whose as_of exceeds the freshness bound or whose claimed_as_of
   lies in the future — the roster_audit future-timestamp failure becomes a hard validation rule.
3. **Headline metric = sustained worker-minutes** (integral of /proc-verified concurrency), not
   peak snapshots.
4. **Fix `scripts/supervision/service.py` `task_event()`**: count only genuinely
   running/implementing states as active; blocked/review/accepted/delivered are not active.
5. **Acceptance re-run:** 10-worker burst where roster-active is within ±1 of /proc-verified live
   workers at every sampled instant; zero SUCCESS self-reports without independently accepted
   artifacts; no future timestamps anywhere in the artifact chain.

### scale50-12 (quota-launcher; "Task-ID/cgroup/receipt dedup projection"; status blocked on owner-lease)

1. **Durable identity keys:** supervision identity/dedup keyed on stable actor tag + generation
   epoch, not session id; freeze `previous_ids` growth; require `rf.guarded_effect` /
   `rf.authorize` fencing on admission and on the wake path (Section 2 item 4).
2. **ended/unknown taxonomy with current timestamps** per the entry's acceptance: every queued
   recipient resolves to live-owner (PID + first-tool verified) / busy / draft-protected /
   NOTREADY / ended / unknown — never inferred from age.
3. **Composer feed repair per Section 2:** snapshots emitted from verified liveness only;
   blocked-beyond-SLO escalates to owner head/principal or expires explicitly; no timeout-delivery
   path exists anywhere in code.
4. **Unblock path:** the entry is blocked on `owner-lease`; quota-launcher head ACK against this
   exact scope is the next action, with wake-path fencing as the first owned slice.

### scale50-31 (agent-dashboard; "Correct candidate worker state freshness"; status blocked on candidate-lease)

1. Implement the acceptance literally: candidate active requires genuine current execution;
   stale/ended/review-only ⇒ UNKNOWN, never ACTIVE. Concretely, the state projection reads
   liveness + transcript recency + generation epoch, and exposes the same
   ready/busy/draft/NOTREADY/ended/unknown vocabulary as the composer feed so dashboard and
   supervision cannot diverge.
2. Negative tests: ended_at+review, PID reuse, missing timestamps, active-reasoning — feed
   directly into dependent task scale50-32's test matrix.
3. This is the dashboard-side face of the same defect class as scale50-E; share one vocabulary and
   one authoritative store (Phase 1 fix 5) so a fourth fragmented store does not appear.

**Sequencing:** scale50-E items 1–2 and the `task_event()` fix are hours-level and unblock
truthful measurement immediately; scale50-12 fencing/unblocking is 1–2 days; scale50-31 rides the
same store. RAM-profile changes (Analysts 4/5) are required by no pinned evidence and must not
precede a staged ramp with RSS monitoring.

## 5. Cross-panel acknowledgments

- **Accepted from Analyst 1:** F1 (120s payload timeout vs >170s real turn; validated by episodes
  43–45 completing after the 600s change) is the cleanest proven mechanical killer. Their F5
  correctly identified the empty readiness producer; only the timeout-delivery remedy is rejected
  (Section 2).
- **Accepted from Analyst 2 / Challenge 4:** backlog ownership (only ~12–17 of 58 slices had
  genuine owner ACKs), not launcher admission, bound useful work — consistent with my
  evidence-integrity verdict. Analyst 2 also documents an environment fault ("No permission client
  configured") which I independently reproduced during this Phase 2 write-up (intermittent Bash
  rejections between successful calls) — a real toolchain-reliability finding, distinct from any
  scope-3 cause.
- **Synthesis:** the 25-burst produced zero accepted artifacts and the head was lost at 17:22Z one
  minute after the snapshot: the Oct 3–6 outcome was decided by evidence integrity and custody,
  not by RAM or provider quota.

## Unknowns (unchanged, truthful)

- Exact mechanism that ended worker lives at ~45s: unidentified; transcripts simply stop, no kill
  record found.
- Total provider quota burned by failed episodes: unknown; no measurement existed, none inferred.
- Whether any burst-25 outcome was ever independently accepted: none found; absence of evidence,
  not proof of impossibility.

— Successor Analyst 3, Phase 2. All re-verification checks were executed read-only on 2026-10-06.
