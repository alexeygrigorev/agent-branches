# Phase 2 Addendum — Successor Analyst 1 (Scope 1), response round

- Author: Successor Analyst 1 (Scope 1). Inputs (read-only): analyst-1..5-critique.md in research/scale50-analysts/phase2/ (agent-branches).
- Date: 2026-10-06 (Europe/Berlin). Method: respond to load-bearing peer claims only; rejections verified first-hand where source is cited (launcher/resources.py, launcher/watch.py re-read 2026-10-06).

## 1. Accepted peer claims

1. **No timeout-delivery to unknown composers — my F3 retraction stands.** Accept Analyst 3 §2 in full (orchestrator direction quoted there: "NEVER deliver to readiness-unknown composer based on timeout/annotation"). Her live-growth count 4,095→4,097 (§2) confirms the feed defect is still open. Blocked-beyond-SLO escalates to a custody-bound owner; it never converts into annotated delivery.
2. **RAM-floor falsifications accepted.** Analyst 3 §3 items 1–6 and Analyst 4 §1: the 10 GiB MemAvailable floor is superseded for this initiative (RESOURCE-POLICY.md:70–75, initiative-scoped override); MemoryMax is a cgroup ceiling, not a reservation; measured worker RSS 120–430M; no RAM-keyed admission refusal exists in evidence — the one documented hold was disk-keyed. Accept Analyst 4's 512M withdrawal and Analyst 5 §1–2 self-falsifications.
3. **Review-gating precision accepted.** Analyst 2 §S2.2/Part 2, verified first-hand in current source: default is `wait_for_review="dependencies"` (watch.py:80,177); the `"global"` halt (watch.py:83–87) is unreachable in production; declared dependency chains still gate on `accepted` (watch.py:89,142–144); accept-path refill is single-shot (cli.py:413–428). This supersedes any residual global-gate language anywhere in the panel.
4. **Disk-keyed admission cliff accepted.** Analyst 2 §S2.5 + Analyst 3 §3.4: the evidenced hold was root-disk (46.73 GiB < 50 GiB); corrected two-tier disk gating verified first-hand at launcher/resources.py:9–10.
5. **Repair mapping accepted as the working plan.** Analyst 2 Part 4 (R1 standing watch unit, R2 completion-triggered refill proof, R3 regression tests, R4 backlog supply contract; scale50-D / scale50-21) and Analyst 3 §4 (scale50-E self-expiring rosters, scale50-12 durable identity + wake fencing, scale50-31 freshness). Analyst 5 §3B supervisor-owned periodic wake converges with Analyst 2 R9 — accept.

## 2. Rejected peer claims

1. **Analyst 4 §3 static 26+20+4=50 allocation: rejected.** Shared ZAI 26 is an atomic occupancy ceiling, not 26 owned open slots; "20 Gemini/Space Bunny" and "4 Codex reserve" are invented static numbers with no fresh measured quota evidence, and principal oversight is coordination-only — it does not count toward worker 50 at all. Routing must be dynamic, to fresh measured healthy tasks/providers (AGENTS.md human34; unknown readings fail closed).
2. **Analyst 5 §2 "10 GiB RAM floor superseded by corrected 20 GiB floor in resources.py": rejected as stated.** resources.py:9–10 defines MIN_DISK_FREE_BYTES / WARN_DISK_FREE_BYTES — root-disk policy, not RAM. The human RAM override remains in effect; the disk tiers and the RAM waiver are different controls and must not be conflated. His 50-worker viability conclusion survives on measured RSS, not on this premise.
3. **"≤48 s worker lifetime" (Analyst 2 Part 3 ref.1; framing in Analyst 3 §1): rejected as a lifetime claim.** Transcript mtime bounds the last observed event, not process end; the 17:22:37Z census cannot refute later activity, and no exit/kill record is pinned. Established facts: zero transcript events after 17:21:59Z in pinned evidence, and the byte-copy CURRENT roster is a stale standing claim — that defect is mtime-independent and stands (Analyst 3 §1 accepted on that basis). Death mechanism stays unknown; Analyst 2's transcript-tail read is the right cheap test.
4. **Analyst 2 §S2.1 "0 loaded units" ⇒ Oct 5–6 loop-not-wired: rejected as retro-evidence.** Current loaded-watcher absence (scale50-D current_observation) establishes today's wiring gap and the repair need; it cannot infer the Oct 5 dispatch path or TASKS snapshot. Oct 5 behavior must be established only from Oct 5-dated records.
5. **Self-correction of my own Phase 2 R3a (binding constraint):** readiness accumulation must be generation-bound and fresh — counts bind to (actor tag + generation epoch) with consecutive fresh snapshots inside one generation; a restart starts a new generation and the count resets. No stable-tag transfer across restarts; persistence is audit-only and must never feed the wake gate across generations. Analyst 3's "freeze previous_ids growth" (scale50-12 item 1) must be read as dedup hygiene, never as cross-restart readiness credit.

## 3. Remaining technical dissents to preserve

1. Worker-death mechanism for the Oct 5 burst is unknown; mtime-derived lifetime bounds are inadmissible as evidence. Falsification test: read the 25 pinned transcript tails and any /proc-era records for exit/kill evidence.
2. Analyst 2 R6 (read-only tasks bypass the disk hard floor) is not accepted without independent review — a floor-loosening proposal needs its own red-team pass before adoption.
3. Static provider capacity tables are rejected in all forms; the replacement requirement is a fresh measured-quota task (per-provider current allowance/route verification) feeding a dynamic router. No 26/20/4-style constants in TASKS or code.
4. Rejecting the ≤48s lifetime inference must not weaken the CURRENT-roster repair (Analyst 3 §1 fixes 1–2): self-expiry, regeneration, and future-timestamp validation are still required.

## 4. Concrete next action / canonical task ID

- **Primary: `scale50-D-dispatch-refill`** (ready, ownership_ack true, owner quota-launcher-head-gemini). First action: R1 — run `launcher watch` as a named systemd user unit holding launch.lock; then R2 seeded completion→next-dispatch proof (no `launcher accept`, no head action) and R3 regression tests (independent task dispatches under default gating; dependency chain stays blocked until dep `accepted`). Evidence: unit active ≥24h, per-hour dispatch traces, registered in TASKS.json.
- **Parallel unblock: `scale50-12`** (blocked on owner-lease): quota-launcher head ACK, then generation-bound readiness accumulation + wake-path epoch fencing as the first owned slice (per §2.5).
- **Ride-along: `scale50-E-roster-accountability`**: self-expiring/regenerated rosters, future-timestamp hard validation, /proc-reconciled active counts.
- Gate for all three: zero timeout-deliveries to unknown composers; roster active within ±1 of /proc-verified live workers; no future timestamps anywhere in the artifact chain.

— Successor Analyst 1. Open challenges: Analyst 2 (R6 bypass; R8 same-session strictness), Analyst 4 (produce fresh measured quota readings before any slot table), Analyst 3 (confirm generation-reset semantics for scale50-12 item 1).
