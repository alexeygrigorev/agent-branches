# Phase 2 Critique — Successor Analyst 1 (Scope 1)

- **Author:** Successor Analyst 1 (Scope 1), Phase 2 mutual cross-reading of the 5-analyst scale-50 panel.
- **Date:** 2026-10-06, Europe/Berlin.
- **Inputs (read-only):** `research/scale50-analysts/analyst-1-report.md` ... `analyst-5-report.md`, `research/scale50-analysts/CROSS-READING-AND-CHALLENGES.md` (all in /home/alexey/git/agent-branches), plus independent re-verification of code, policy and git-reflog evidence named below.
- **Method:** every load-bearing claim in Sections 1-4 was re-checked against primary sources (launcher source at /home/alexey/git/agent-quota-launcher, scripts/supervision/service.py, coordination/TASKS.json, coordination/RESOURCE-POLICY.md, launcher .git/logs/HEAD) before being confirmed or challenged. Claims I could not re-verify are marked as such.

## 0. Verdict summary

1. Analyst 3's empty-readiness-pipeline finding is **confirmed and accepted as policy-binding**: no delivery may ever be made to an unknown composer on timeout. Analyst 1's original proposal F3 ("deliver with a `readiness-unknown` annotation after SLO expiry") is **retracted** in Phase 2; genuine composer-feed repair is required instead.
2. The cleanup 120s-to-600s fix is **confirmed fixed in source** (pinned commit `a1e3f84`, not `eb9158e` as the cross-reading document states — discrepancy flagged in section 2.1), but two residual 120s stores and the missing payload-timeout regression test remain open.
3. Store consolidation is **directed but NOT landed**: `get_ql_db_candidates` still scans only three stores and still omits the fourth live store the maintained launcher actually used; the watcher staleness threshold is still 120s.
4. Analysts 4 and 5's RAM-floor reasoning is **falsified on both premises**: the 10 GiB MemAvailable floor was superseded for this initiative (now an env-gated override in code), and `MemoryMax=768M` is a cgroup v2 enforcement ceiling, not wired memory. Their 512M "mathematical necessity" claim does not survive.
5. Concrete repairs are mapped to canonical IDs `scale50-A-dispatch-repair` (ready, owner-ACKed) and `scale50-21` (blocked on owner-lease, needs genuine ACK and re-baselining) in section 4.

---

## 1. Empty readiness pipeline (Analyst 3 F6, corroborated by Analyst 1 F5) — accepted, with the policy correction

### 1.1 The convergent finding

Both scopes independently observed the same outage: `pending-blocked-beyond-slo` grew 261 -> 1,060 -> ~2,768/day over Oct 4->5->6 (Analyst 1 counted 4,087 total events, Analyst 3 4,095 — an immaterial snapshot-time drift of 8 events, both magnitudes agree), each carrying `recipient not ready: unknown (composer: unknown, ready_snapshots: 0)`. I re-read the producer to confirm the mechanism is structural, not incidental:

- `scripts/supervision/service.py:808-820` (`eligible()`): a recipient counts as ready only when **all** of these hold — workload PID alive in `/proc`, `reported_state` in (`idle`, `waiting`), the composer screen classifies `empty` (pane not busy, not mid-draft, not NOTREADY), and for `codex-principal` a fresh quota pass. Any miss returns `ready_snapshot_count = 0` with a truthful reason.
- `service.py:825`: the count accumulates **only across consecutive cycles of the same `session_id`** — exactly the mechanism Analyst 3 identified as defeated by identity churn (14 `previous_ids`) and by the F2 restart churn (each restart rebuilds in-memory state, resetting `same` to false), so the >=consecutive-ready-snapshots wake gate was never satisfied.
- `service.py:1217-1253`: a missing-or-ambiguous session match force-resets the count to 0 and marks the principal not alive — so the Oct 6 identity churn converted directly into `ready_snapshots: 0`.

So the policy-correct blocking (do not wake a pane you cannot prove is idle) became a **delivery outage** because the feed that proves readiness was structurally starved. That split — correct policy, broken instrument — is the right root-cause division between Scope 1 and Scope 3, and I accept the cross-reading's reconciliation of Challenge 3.

### 1.2 The retraction: never deliver to unknown composers on timeout

Analyst 1's original fastest-fix #3 proposed: after SLO expiry, deliver anyway with an explicit `readiness-unknown` annotation. The desktop orchestrator directed otherwise — "NEVER deliver to readiness-unknown composer based on timeout/annotation; repair genuine feed/owned-queue/custody respecting busy/drafts/NOTREADY" — and I uphold that directive as correct, for five reasons:

1. **It manufactures readiness evidence.** The annotation would record "delivered" for a message whose recipient was never proven ready. That converts an unknown into a false positive — precisely the evidence-fabrication class AGENTS.md forbids ("never invent readiness", "do not replace evidence with busy indicators") and the exact false-positive class this panel was convened to eliminate.
2. **It risks interrupting busy and draft-protected panes.** `composer: unknown` means the screen classifier could not prove the pane is not mid-draft. Injecting a wake into a pane composing a draft destroys peer work — a harm the coordination rules treat as worse than delay.
3. **Custody becomes untraceable.** With an unknown composer and (per Analyst 3) identity churn resetting session identity, a timeout-delivery cannot be bound to a durable owner. Undeliverable-but-recorded-as-delivered messages are worse than honestly-parked ones: downstream actors will act on the assumption of receipt.
4. **Timeout is not evidence of readiness.** SLO expiry proves *our* message aged out; it says nothing about the recipient's state. Using elapsed time as a delivery trigger inverts the signal.
5. **It would have hidden the real defect.** Annotated delivery would have drained the `pending-blocked-beyond-slo` counter — the one loud, truthful symptom that the readiness feed was empty — and the composer-feed defect would have persisted silently. The outage metric was doing its job.

### 1.3 What genuine composer-feed repair must be

Because blocking was correct and the feed was broken, the repair targets the feed, not the blocking policy. Concretely:

- **R3a — Durable readiness accumulation.** Persist per-`session_id` ready-snapshot counts in the supervision state file so restarts and cycle length no longer reset them; accumulate on the durable tag, not on in-memory cycle state (aligns with Analyst 3's fix #4, durable sender keys).
- **R3b — Fix the eligibility inputs, fail truthful.** Audit why `eligible()` never accumulated: the `composer()` screen classifier's non-empty reasons (which specific kind dominated the 4,095 events must be tabulated — see section 7 unknowns), the missing-or-ambiguous-principal path, and the codex-principal fail-closed quota reading. Each non-zero-ready reason should appear in the periodic report so an empty feed is visible as a named defect, not a zero.
- **R3c — Wake gate on genuine readiness only.** Keep the >=consecutive-ready-snapshots gate exactly as designed once R3a/R3b make the count trustworthy. No timeout-based delivery path, ever.
- **R3d — Escalate, don't park.** For a pending message whose recipient is genuinely absent (dead PID, no session), the proactive-blocker contract applies: name an owner, record the blockage, and route the wake to the recipient's **head or principal** — a known, custody-bound actor — instead of holding the message forever against an unknown composer. This is the honest alternative to Analyst 1's original proposal: escalation to a *known* owner is the opposite of delivery to an *unknown* one.
