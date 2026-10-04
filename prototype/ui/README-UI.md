# Agent Branches — change story review UI (A06)

Plain static screens for reviewing what concurrent coding agents did:
`index.html` (overview of all agent tasks) and `task.html?id=…` (one agent's
change story). No frameworks, no build step, no dependencies — HTML, CSS and
vanilla JS only. The Worker is expected to serve this folder as static assets
later; today it runs from any static file server.

## Open with fixtures (no server needed for data)

The UI can demo itself from `fixtures/`:

```bash
cd prototype/ui
python3 -m http.server 8765
# then open:
#   http://localhost:8765/index.html?fixture=1            # base demo set
#   http://localhost:8765/index.html?fixture=semantic     # semantic-conflict demo
#   http://localhost:8765/index.html?fixture=lost-push    # lost-push (unprocessed) demo
#   http://localhost:8765/task.html?id=task-0001&fixture=1
#   http://localhost:8765/task.html?id=task-0009&fixture=lost-push
```

Rendered evidence (captured with the headless Chromium shell, 2026-10-03):
`ui-evidence/` — index + task pages for the base and lost-push sets.

`?fixture=1` loads `status.json`; any other value `<name>` loads
`status-<name>.json` (and task pages load `<name>-<taskId>.json`).

Any static file server works. Opening `index.html` directly from disk
(`file://`) does **not** work, because browsers block `fetch()` of local JSON
from `file://` pages — the folder must be served over HTTP.

## Live updates (CONTRACT 0.1.3)

Both pages re-fetch `GET /status` every 3 s and pause while the tab is hidden
(resuming — with an immediate catch-up fetch — when it becomes visible).
A status line above the content shows the current state: live/demo,
last-loaded time, and whether the tab is paused or a fetch failed.

Requests are single-flight guarded (C-1385): each refresh takes a generation
and a response that settles after a newer one is dropped, so an
out-of-order result can never overwrite newer state. When a `/status` fetch
fails, the page never pretends to be clean: an explicit red banner
(`role="alert"`) says the live status is out of date, the task page marks the
affected sections “Status out of date” (an empty warning list reads as
unknown, not as “no warnings”), and only a later successful fetch clears the
banner. See `request-guard.js` and `tests/generation-guard.test.js`.

Newly appeared warnings and pushes are highlighted (amber outline + a “New”
badge) for 5 s. The first page load only establishes a baseline — nothing is
highlighted just for being there. In fixture mode the same machinery re-reads
the fixture files, so editing a fixture is a honest way to demo the
highlighting and the state transitions.

Warnings are displayed with their acknowledgements from
`POST /warnings/:id/ack` (the `acks[]` records of the 0.1.3
`WarningRecord`): who acknowledged, at which head, when, and with which
note. The legacy `acknowledgedBy[]/acknowledgedAt` shape still renders
(without head/note). Each agent card and the task page carry a compact
**timeline strip** (`+ push · ! warning · ✓ acknowledged`, oldest → newest,
tooltips with details).

## Lost pushes — the head is UNKNOWN (codex C-1357)

When the sidecar could not deliver a push notification, `GET /status` lists
it under `unprocessedPushes` and forces every pair involving that agent to
`not_checked` with an `unprocessedReason`. The UI treats this exactly as the
safety rule demands:

- a dedicated “Pushes that never arrived” section lists each lost push with
  repo, change, attempts, last error and first/last attempt times;
- the affected agent card and task page show **Latest change: Unknown**
  (never the possibly-stale sha) with the reason;
- `pair-status.js` additionally derives the gate from
  `status.unprocessedPushes` itself, so even an older cached pair view that
  still says `clean` can never render as safe.

The `lost-push` fixture set demonstrates this end to end:
`grok-0009`'s newest push (`7b8c9d0…`) was reported 3× with
`worker responded 401`, so both pairs involving `grok-0009` are not checked,
its head shows UNKNOWN, and its task page explains that no test run can
cover a change the server never saw.

The base set shows three of the four pair states with three agents:

- `claude-0001` ↔ `codex-0002`: **conflict** — the pair's own radar result
  says `conflict` at the current heads (both changed
  `prototype/src/index.ts`; warning acknowledged by `claude-0001`).
- `claude-0001` ↔ `grok-0003`: **clean — tests ran** — the pair's radar
  result is `clean` at the current heads and its combined run collected
  tests (`coverage.tests_collected = 3`). Note `claude-0001`'s *own* last
  test run is stale — per-agent evidence no longer matters for the pair.
- `codex-0002` ↔ `grok-0003`: **not checked** — the radar saw no merge
  conflict, but it never ran combined tests for these disjoint changes, so
  the pair is not proven to work together.

The `semantic` set is the important negative demo (codex C-1334): all three
agents are individually green (each has a passing `exit 0` test run at its
latest change), yet:

- `claude-0004` ↔ `codex-0005`: **conflict** (`kind: "test"`) — both rewrote
  the same auth helper; each passes alone, the combination fails.
- `claude-0004` ↔ `grok-0006`: **unknown — not safe** (combined run timed
  out).
- `codex-0005` ↔ `grok-0006`: **clean — tests ran** (combined run passed,
  5 tests collected) — green + green *can* be clean when the radar proves it.

Task pages: `task-0001` shows a test run that no longer matches the latest
change (stale evidence → "not proven safe" on the task page), `task-0002`
a passing run at the latest change, `task-0003` a passing docs-adjacent run.
The semantic set's task pages (`task-s1`…`task-s3`) show passing runs while
the overview still reports the pair conflict.

The outline **not checked** badge appears whenever the pair has no fresh
radar result at the current pair of heads — e.g. right after a push, when an
agent has not pushed anything yet, or when a merge was clean but no combined
tests ran.

## Tests

The pair-safety decision (`pair-status.js`) and the view logic — polling
cadence, highlight windows, acknowledgements, timeline, lost pushes —
(`view-logic.js`) live in dependency-free pure modules loaded by both the
browser and the tests:

```bash
cd prototype/ui
node --test        # or: npm test
```

## Open against `wrangler dev`

```bash
cd prototype
npx wrangler dev --local        # http://localhost:8787
```

Then serve `prototype/ui/` from any static server (as above) and open:

```
http://localhost:8765/index.html?api=http://localhost:8787
http://localhost:8765/task.html?id=task-0001&api=http://localhost:8787
```

Caveat: the Worker does not send CORS headers yet, so a browser may block
cross-origin calls from `:8765` to `:8787`. Same-origin use (no `?api=`)
works once the Worker serves this folder as static assets — that integration
is planned on the Worker side and will land with the expected branch merge.

## Data sources and honest fallbacks

| Screen | Endpoint | Notes |
| --- | --- | --- |
| `index.html` | `GET /status` | agents, heads, warnings, radar log |
| `task.html` | `GET /tasks/:id` (+ `GET /status`) | task detail, agent record; status supplies warnings for this agent |

The current L1 scaffold does not yet carry `intent`, `baseSha`, `pushLog`,
warning acknowledgement (`acknowledgedBy`/`acknowledgedAt`) or
`testEvidence`. All are optional: when missing, the UI shows plain
“not recorded / not stated” fallbacks and treats safety as **unknown**, never
as safe. Fixtures demonstrate the richer shapes the contract is expected to
grow into.

## Safety labels (the important rule)

Pair states come **only** from that pair's own radar result in `/status`
(`status.pairs`, the L1 contract v0.1 `PairStatusView`):

- **conflict** — the pair result says `conflict` at the current heads of both
  agents (any kind, including `test`: each side passes alone, the combination
  fails).
- **clean — tests ran** — the pair result says `clean` **and** was checked at
  the current heads of both agents **and** its coverage/evidence records a
  combined run with `tests_collected > 0`.
- **unknown — not safe** — the pair result says `unknown` at the current
  heads.
- **not checked** — anything else: no pair result, stale result (a head has
  moved since the check), `not_checked`, a `clean` result with no recorded
  combined test run, or an unprocessed (lost) push for either agent.

Each agent's own test evidence is shown on its task page, but it is **never**
an input to the pair badge: two individually green agents can still clash
when combined — that is exactly the semantic-conflict case, so it must never
upgrade a pair to safe.

Per-agent heads are read keyed by agentId (`heads[agentId]`) per the
contract; older positional `heads.a` / `heads.b` data is tolerated.

Unknown is never rendered as green/safe; badges always carry their text
label, never color alone.

## Review decisions

`task.html` has a review decision area (approve / request changes / note).
Decisions are stored in `localStorage`, one key per task id, in this browser
only — nothing is sent to the server. Clearing is one click.
