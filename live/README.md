# Live end-to-end demo — Agent Branches prototype (run 3)

Branch `proto/live` (integration of L1 @ 3e9983b CONTRACT 0.1.2, L4, L5; see
`git log --oneline ace104f` for the merge). One command reproduces the whole
demo; all steps are idempotent via markers in `live/state/` and leave evidence
in `live/evidence/run-3/` (run 2's evidence stays in `live/evidence/run-2/`).

**Run 3 result (2026-10-03, zc-live-5): 36/36 assertions passed** — see
`live/evidence/run-3/result.json` (machine-readable), `summary.txt`,
`ui-index.png` + `ui-task-task-0002.png` (review UI rendering live data,
visually inspected — not just size-checked), `ui-pairs.json` (the UI's own
pair-status decision on live /status), `radar1-l1.json` / `radar2-l1.json`
(posted to /checks VERBATIM), `checks1-receipt.json` / `checks2-receipt.json`,
`stale-409.json`.

## Run 3 headline: green on the CURRENT contract with the run-2 gap list closed

- **Typed wire end to end (G4/G5 closed).** The radar's contract-`"0.1"`
  payload (object `policy`, counts `coverage`, per-result `heads` + typed
  `evidence`) is POSTed to `/checks` verbatim. The down-conversion
  `*.posted.json` shim is deleted; no `[object Object]` anywhere in the UI.
- **Tasks carry intent + base_sha.** Intents are distilled at runtime from
  `demo-target/TASKS.md` (heading + tests-to-add line); `base_sha` pins the
  canonical seed commit. `GET /status` agents now expose `intent` + `baseSha`
  (additive worker change on proto/live for L1 to adopt), so the UI cards show
  what each agent is doing and which commit it started from — no more
  "Not stated yet / not recorded".
- **Designed matrix asserted honestly (G8 closed).** T1-T3 is a REAL textual
  overlap (both patches insert routes at the same anchor in `src/worker.js`;
  reproduced with `git merge-tree` and codified as FACT 4 in
  `demo-target/verify-overlap.sh` — ALL 4 FACTS VERIFIED). The assertion
  requires `conflict`+`textual` for T1-T3; nothing "expected clean" accepts a
  conflict. Fixture docs corrected to "three designed conflicts: two textual
  + one test".
- **Warnings counted per pair, new + existing.** The receipt assertion checks
  every conflicting pair has an ACTIVE warning (newly created OR reused via
  the coordinator's pair+headsAtIssue dedup) — pass 2 legitimately created 2
  and reused 1, and that now passes by semantics, not by luck.
- **T2-T3 coverage.** The test conflict surfaces per-pair
  `coverage.tests_collected = 19 > 0` in /status (radar now parses node:test
  summary lines and records `tests_collected` on failing combined runs too),
  and the UI's own `pair-status.js` badges all three pairs "Conflict" —
  asserted from live data, not eyeballed.

## Prerequisites

- node + npx (wrangler dev), python3 (radar runner, assertions), git, rsync
- headless Chrome at
  `~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`
  (only for the screenshot step; override the path in `run-demo.sh` if needed)

## Exact commands

1. Create the untracked token file `live/.dev.vars` (never committed; ignored by
   `live/.gitignore`). Tokens are arbitrary bearer strings you choose:

   ```sh
   # live/.dev.vars  (mode 600)
   export ADMIN_TOKEN='<random>'
   export RUNNER_TOKEN='<random>'
   export SIDECAR_TOKEN='<random>'
   export SIDECAR_PORT=8799
   export WORKER_PORT=8787
   export UI_PORT=8788
   ```

   Ports 8797/8798 belong to the Antigravity head — do not use them.

2. From the repo root (so `python3 -m radar` resolves):

   ```sh
   cd /home/alexey/git/agent-branches-live
   bash live/run-demo.sh > live/run-3.log 2>&1
   echo "exit=$?"   # 0 on success
   ```

   Never pipe the script's stdout into `tail -f` or similar: server processes
   inherit the pipe and hold it open. Read `live/run-3.log` and
   `live/evidence/run-3/result.json` instead.

3. Inspect results:

   ```sh
   cat live/evidence/run-3/result.json    # assertions, machine-readable
   cat live/evidence/run-3/summary.txt    # same, human-readable
   python3 -m json.tool live/evidence/run-3/status.json | head -40
   ```

To re-check a finished run without redoing data steps, just rerun step 2 —
markers skip everything except services + final assertions. To force a full
fresh run: `rm -rf live/state live/artifacts prototype/.wrangler` (task
records bake in intent/base_sha, so changed task payloads need the wipe).

## What the script does (in order)

1. Starts the L1 local-artifacts sidecar (:8799) and `wrangler dev` (:8787);
   both health-checked, started only if down, `</dev/null`, logs to files.
   Each server runs under `setsid` in its OWN PROCESS GROUP; the recorded pid
   is the group leader; cleanup kills the recorded GROUP (`-PGID`) after
   cmdline + group-leader + not-my-own-group checks, TERM→KILL escalation,
   then verifies the demo ports are actually free (holders get logged, never
   killed by pattern).
2. `POST /setup` (ADMIN_TOKEN) — creates the canonical repo (idempotent: returns
   the existing one), mints a canonical write token on the sidecar admin API,
   clones, seeds `demo-target/` (minus `.harness/`) and pushes the baseline.
3. `POST /tasks` x3 (admin) — each body carries the task's `intent` (from
   `demo-target/TASKS.md`) and `base_sha` (the canonical seed commit); forks
   get per-repo write tokens.
4. Applies the three reference patches as the three agents' pushes
   (authenticated clone + push; belt-and-braces `POST /events/push` now
   authenticates with the agent's own task token — the route is token-gated
   since contract 0.1.1).
5. Radar pass 1 (`python3 -m radar --l1`) at the 3-agent vector;
   `POST /checks` posts the typed payload VERBATIM with RUNNER_TOKEN.
6. Phase-1 assertions.
7. Stale probe: churn push on t1, replay of the old radar payload → 409.
8. Radar pass 2 at the new vector; `POST /checks` again (verbatim payload).
9. Evidence: `/status` JSON, headless-Chrome screenshots of the review UI
   (index + one task page) served on :8788 via `?api=`, and `ui-pairs.json`
   from running the UI's own `pair-status.js` against the live /status.
10. Final assertions → `live/evidence/run-3/result.json`.

## GAP LIST — run-2 items and where they stand now

**G1 · Process hygiene — CLOSED in the script (verified this run).** Exact
prior-executor termination records (causes are not invented post-hoc):
zc-live-integration exited EXIT 143 — cause UNKNOWN, self-kill is the standing
hypothesis; zc-live-2 ended RUN_EXIT 137 — cause UNKNOWN, OOM not excluded;
zc-live-3 was stopped INTENTIONALLY by claude-principal for the warm-path
switch. The earlier "120m orchestrator timeout is equally plausible" text was
WRONG and is gone: that run died after ~2 minutes, so a 120-minute timeout is
impossible. Run 3 mechanics: every demo server starts via `setsid` as its own
process group; cleanup kills the recorded GROUP (`-PGID`) — taking wrangler's
workerd child down with it — after identity checks (cmdline substring,
group-leader, refusal when the target group is the script's own), with
TERM→KILL escalation; a final pass asserts the demo ports are free and logs
holders instead of killing them. Both runs ended with :8787/:8788/:8799 free
and no orphaned workerd.

**G2 · Sidecar requires a per-repo token on EVERY git endpoint — CLOSED
(already in run 2, kept).** All clone/fetch/push calls authenticate with
minted per-repo tokens, `GIT_TERMINAL_PROMPT=0` is exported, fresh read tokens
per radar pass. Contract 0.1.1+ additionally token-gates `POST /events/push`:
run 3's belt-and-braces event posts now carry the pushing agent's own task
token (run 2's anonymous post would 401 against the current worker — caught
live during run 3's first attempt).

**G3 · Assertions/contract drift — CLOSED.** Assertions are written against
the contract 0.1.2 response shapes (typed receipt, `currentHeads` in the 409,
radar-kind reasons). CONTRACT.md publishes the exact shapes (0.1.2).

**G4 · radar `policy` object vs string — CLOSED.** No conversion anywhere:
the typed `{merge, tests}` policy object is posted and recorded verbatim
(`contract: "0.1"` is mandatory — missing/unknown = 400).

**G5 · radar evidence object vs string — CLOSED.** The typed evidence object
is posted verbatim, stored as `evidenceDetail`, and served on the pair view;
the UI renders only its string `summary` and never `[object Object]`
(verified in the screenshots).

**G6 · No CORS for the documented UI usage — CLOSED on proto/live** (CORS
headers + OPTIONS preflight in `prototype/src/index.ts`, kept through the
merge). L1 should adopt it.

**G7 · Vacuous screenshot assertion — CLOSED.** Run 3's screenshots (index +
task page) were visually inspected by the executor: intents, base SHAs, all
three Conflict badges (textual/textual/test), warnings with reasons, no
`[object Object]`. Additionally `ui-pairs.json` pins the badge states by
running the UI's own `pair-status.js` on the live /status, and assertions
check it — a machine check of exactly what the UI would render.

**G8 · Fixture drift in demo-target — CLOSED.** T1-T3 is a real textual
overlap (same route-insertion anchor in `src/worker.js`), now asserted as
`expected conflict (textual, real overlap)`; `SOLUTIONS.md` corrected to
"three designed conflicts: two textual + one test"; `verify-overlap.sh` gained
FACT 4 (T1+T3 textual conflict) — ALL 4 FACTS VERIFIED on this tree.

**G9 · State/marker vs fresh-service combos — CLOSED** (runid marker +
canonical-exists check + ordering documented; consistent across run 3's
restarts). Note: changed task payloads (intent/base_sha) require wiping
`live/state`, `live/artifacts` AND `prototype/.wrangler` (DO state), since
task records bake them in.

**G10 · Small executor bugs — CLOSED** (start_bg shift, wait_for auth headers,
declare -A; all fixed in run 2 and kept).

**G11 · Tokens on the wrangler command line — OPEN (flagged for L1).**
`--var ADMIN_TOKEN:…` is still visible in `/proc/<pid>/cmdline`; a
`prototype/.dev.vars` (untracked) would avoid the exposure. Kept the single
token source for run 3.

**G12 · Empty-clone default branch — CLOSED** (`symbolic-ref HEAD
refs/heads/main` guard; moot in practice since the sidecar auto-seeds).

**G13 · Handoff state drift — CLOSED.** This run's handoff carried the branch
head SHAs, committed-vs-WIP state and the exact tasking; no redo of peer work
was needed.

**G14 · NEW (run 3, open, for L1): canonical seed push lands in the
unprocessed-pushes ledger.** The sidecar's post-receive callback for the
SEED push to the canonical repo gets `worker responded 400` (no agent owns
the canonical fork yet at seed time), retries 3x, and records it in
`notify-state.json` → `GET /status` shows one `unprocessedPushes` entry with
`agentId: null`. Benign today — the C-1357 guard only forces pairs to
`not_checked` for AGENT forks, so no pair is affected and all assertions
pass — but the ledger should not carry a permanent entry for the documented
seed flow. Suggested fix: `/events/push` returns 202 `{accepted: false}` for
repos owned by no agent (mirroring `/events/artifacts`), or the sidecar skips
notification for the canonical repo.

## Ownership / recovery

- Branch `proto/live`, worktree `/home/alexey/git/agent-branches-live`,
  pushed to `origin`. Evidence is committed. Tokens and runtime scratch
  (`live/.dev.vars`, `live/state/`, `live/work/`, `live/artifacts/`, logs,
  `prototype/.wrangler/`) are gitignored.
- Recovery path: ordinary git (`git checkout proto/live`); the demo state is
  fully regenerable via the commands above.
