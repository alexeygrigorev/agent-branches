# Receipt: Scale-50 Recovery Plan Adoption & Stream 5 Roster Accountability (scale50-E)

**Date:** 2026-10-06 (Europe/Berlin)  
**Author:** `ant-head-never-timer-custody-20261006` (Antigravity interactive project head, session `7d87f36b-8d02-4b46-8216-98d6dce3f990`, conversation `ea14b401-20e9-4e48-ab08-d15be08da30d`)  
**Authority:** Enacted canonical `coordination/SCALE50-RECOVERY-PLAN.md` and verbatim human instruction `experiment/human-scale50-solution-followthrough-20261006.txt` ("okay document the solution and make sure in 30 minutes checks that we follow it. agents must report problems and the steps they took to solve them, not blockers.").

---

## 1. Executive Summary & Governance Compliance

In accordance with latest human steering and coordinator governance (`01a11169-af4a-7c10-b529-09100917d5fe`), Ant Head has formally acknowledged and operationalized the five repair streams, avoiding blocker-only reports and delivering concrete executed code, verified independent tests, and durable continuation:

1. **Phase 2 Addenda Corroboration Completed:** All five successor analysts completed their cross-critique addenda. Exact native input read and corroboration receipts were recorded:
   - **Scopes 4 & 5 (Luna verified):** Native `view_file` executed across all five Phase 2 input critiques.
   - **Scopes 1, 2, 3 (ZAI glm-5.3-flash):** Supported bash `sha256sum`, `head`, and line-count checks executed across all five pinned critiques in `research/scale50-analysts/phase2/`, confirming SHA256 hashes (`e851b854...`, `773ef9f8...`, `56215797...`, `40bd6880...`, `68370528...`). Analyst 2 appended Section 5 input corroboration with self-correction on watcher challenge attribution. Pushed to `origin/main` in commit `c9c059b`.
2. **Stream 5 Roster Accountability Implemented (`scale50-E`):** Ant Head implemented `agent_branches/roster.py` and unit test suite `tests/test_roster.py` enforcing:
   - Hard rejection of future-dated `claimed_as_of` timestamps (Corrective Counting Invariant).
   - TTL self-expiry (default 300s): demotes stale roster snapshots to `UNKNOWN`.
   - Live `/proc` process reconciliation: verifies PID liveness against `/proc/<pid>` and demotes dead workers.
   - 35/35 unit tests pass cleanly in `agent-branches` (commit `70be02c`).
3. **Stream 2 Refill Callback Alignment (`scale50-21`):** Operational scoped ACK issued to coordinate completion/refill callbacks under `agent-bus/.local/scale50/scale50-21`, aligning with standing watch daemon and enforcing zero timeout-delivery to unknown composers.

---

## 2. Problem-Report Follow-Through (Actions Already Executed)

Per `SCALE50-RECOVERY-PLAN.md` §2, each item reports concrete actions already taken:

### Problem 1: Un-expiring Standing Rosters Fabricating Current Fleet State (`scale50-E`)
- **Task ID:** `scale50-E-roster-accountability` (agent-dashboard / agent-branches)
- **Target vs Actual:** Target is real-time liveness representation; actual was `ROSTER-25-ACTIVE-WORKERS-CURRENT-UTC.json` retaining a static snapshot from 17:15:59Z with future `claimed_as_of` 19:13:00Z.
- **Confirmed Cause:** Consumer-side presentation defect: absence of TTL self-expiry and failure to reconcile roster membership against live `/proc` PIDs.
- **Current Owner ACK:** Ant Project Head (`ant-head-never-timer-custody-20261006`).
- **Actions ALREADY Executed:**
  - Authored `agent_branches/roster.py` implementing `verify_roster_snapshot()` with future-timestamp hard rejection, 300s TTL expiry, and `/proc` PID reconciliation.
  - Authored `tests/test_roster.py` with 4 test cases covering timestamp parsing, future rejection, TTL expiration, and `/proc` reconciliation.
  - Verified 35/35 passing unit tests in `agent-branches`.
- **Result:** Passing test suite; committed and pushed to `origin/main` (commit `70be02c`).
- **Next Action & Checkpoint:** Integrate `verify_roster_snapshot()` into dashboard JSON generators before Oct 6 22:00 CEST.
- **Durable Trigger:** Native 300s continuation timer (`TimerCondition="never"`).

### Problem 2: Starvation from Serial Backlog Chaining & Accept-Path Coupling (`scale50-D`, `scale50-B`)
- **Task ID:** `scale50-D-dispatch-refill`, `scale50-B-ready-allocation`
- **Target vs Actual:** Target is continuous queue refill to 50 workers; actual was zero loaded standing watcher units and queue starvation.
- **Confirmed Cause:**
  1. Backlog dependency chaining (all ready tasks depended on incomplete parents).
  2. Single-shot accept refill (`cli.py:413-428`), converting review cadence into dispatch cadence.
  3. Total lack of independent, unblocked, substantive tasks in ready reserve.
- **Actions ALREADY Executed:**
  - Panel consensus confirmed `watch.py:80,177` defaults to `wait_for_review="dependencies"`, proving disjoint tasks dispatch freely.
  - QL Head verified relaxation of cleanup timeout to 600s in `a1e3f84` and retry cooldown in `eb9158e`.
  - Dynamic provider routing agreed: rejected static 26+20+4 partition in favor of dynamic routing respecting the ZAI 26 atomic occupancy ceiling.
- **Result:** Falsified software-lock hypothesis; confirmed backlog supply contract as true prerequisite.
- **Next Action & Checkpoint:** QL Head packaging `watch_loop` as standing user systemd unit (`agent-quota-watch.service`), aligned with 15:30 CEST checkpoint.

---

## 3. Preserved Provenance & Dissents Registry

1. **Input Read Provenance:**
   - Exhaustive revised-input reads verified via native `view_file` for the two Gemini analysts (Scopes 4 & 5).
   - Supported bash inspection (`sha256sum`, `head`, line counts) executed for the three ZAI analysts (Scopes 1, 2, 3) in `scale50-phase2-corroboration-{1,2,3}`.
   - Pinned hashes match across all five critique inputs:
     * `analyst-1-critique.md`: `e851b8549475a888a8aa35653bc9d89fcd31f112be921e004ff518977d5dcec9`
     * `analyst-2-critique.md`: `773ef9f810a6a0ecb04fef63d8e9a0696c3d36b7f93eeec87075ddcada01bc03`
     * `analyst-3-critique.md`: `56215797faaf23e06f69a1416eb9ef9e5ea370bf02793ed4916704b6f16f80af`
     * `analyst-4-critique.md`: `40bd6880757bd3f43742df1dc91b1f8060ccef3bee598d51578c051c2a9d8abd`
     * `analyst-5-critique.md`: `683705284be0bc9082db4b47b7fbf50c4426b3ad70a202dc76b1e3fdbfc76069`
2. **Preserved Dissents:**
   - **Worker Termination Mechanism:** Pinned transcripts ended between 17:21:50Z and 17:21:59Z, but exact OS kill triggers remain unrecorded; mtime does not prove 48s process lifetime.
   - **Root Disk Floor Bypass (Analyst 2 R6):** Read-only task bypass of `MIN_DISK_FREE_BYTES = 20 GiB` remains contested and gated pending separate independent review.
   - **Admission Sizing Policy:** Static cgroup containment (768M) vs dynamic RSS stages.

---

## 4. Verification Checkpoint Status

- **`agent-branches` Working Tree:** Clean on `main`, tip at `70be02c`, pushed to GitHub `origin/main`.
- **Targeted Test Suite:** 35/35 passing (`pytest -v tests/test_sync_git.py tests/test_bus.py tests/test_cli_bus.py tests/test_roster.py`).
- **`cloudflare-agent-git` Working Tree:** Zero mutations by Ant Head; declared edit scope strictly `none` (`yours: none`).
