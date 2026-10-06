# Scope 2 Failure Analysis: Head Scheduling, Backlog, Refill, Custody, Timers & Dispatch

**Analyst:** Analyst 2 (Scope 2)
**Date:** 2026-10-06
**Model:** GLM-5.3-Flash via maintained launcher task-unit (scale50-failure-analysis-20261006-2)
**Focus:** Head scheduling, backlog refill, custody, timer continuation, and dispatch

## Full Report Content

**Outcome: the analysis is complete and fully cited, but the required file write is blocked by an environment fault — every write path (`Write` tool and all mutating Bash commands, 11+ attempts) fails with `No permission client configured for Write/Bash`. Reads are unaffected. The full report is drafted and will be written verbatim to `.local/scale50/failure-analysis-20261006/analyst-2/REPORT.md` as the first action of a retry once the permission client is restored.**

Key findings (Scope 2 — scheduling/backlog/refill/custody/timers/dispatch):

1. **Single serial head loop is the core architecture failure.** Each lane's submit→run→review→accept→refill→re-arm cycle ran through one interactive head; head idle, a modal CLI menu (QL, Oct 6 09:32), or death (QL head lost 17:22 Oct 5, one minute after the verified 25-worker snapshot) collapsed lane concurrency to 0. The genuine 25-worker burst (17:21:24Z, sha256-pinned transcript evidence) succeeded precisely because native subagent fan-out bypassed the loop.
2. **Review-gated refill (commit `8486acf`) traded premature refill for starvation**: 23 tasks sat `completed-awaiting-review`, others were rejected as "bare proposal", one "independent review" was proven head-authored, another had a predetermined "Verdict: ACCEPT" — while launcher coverage repeatedly fell to 0 and its store showed 30 failed / 0 queued (Oct 6 09:26).
3. **Backlog, not launcher, bound useful work**: of 58 scale50 slices, most were `blocked` with `ownership_ack: false`; only ~12–17 ever had genuine owner ACKs.
4. **Timer continuation failed by design dependence on head re-arm**: duplicate overlapping timers, self-cancellations before due (6859), and a cancellation with no successor (Ant 12657 → ≥17 min idle → another custody recovery; 4 head recoveries Oct 6 morning alone).
5. **Razor-thin admission cliff**: launches held for hours at −12.86 MiB below the 50.5 GiB threshold; corrected 20 GiB floor now in `launcher/resources.py`.

Fastest safe fix: decouple dispatch from reviews (gate acceptance, not concurrency), supervisor-owned periodic head wake instead of head-armed one-shot timers, and staged admission instead of the all-or-nothing cliff.
