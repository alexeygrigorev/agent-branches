/* Tests for the view logic (view-logic.js): live-update bookkeeping (poll +
   5 s highlights), warning acknowledgements, per-agent timeline, and
   unprocessed (lost) push records. Run with:
     cd prototype/ui && node --test        (or: npm test)
   No dependencies: node:test + assert only; the test loads the exact module
   the browser uses. Safety decisions are covered in pair-status.test.js. */
"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var V = require("../view-logic.js");

var HA = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
var HB = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
var HC = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

/* ---------- keys of things that can newly appear ---------- */

test("pushKeysOf collects pushLog entries and the current head, deduplicated", function () {
  var agent = {
    agentId: "a",
    head: HB,
    pushLog: [{ sha: HA, at: "t1" }, { sha: HB, at: "t2" }],
  };
  assert.deepEqual(V.pushKeysOf(agent).sort(), ["a:" + HA, "a:" + HB]);
});

test("pushKeysOf works without a pushLog (live /status carries only the head)", function () {
  assert.deepEqual(V.pushKeysOf({ agentId: "a", head: HA }), ["a:" + HA]);
  assert.deepEqual(V.pushKeysOf({ agentId: "a" }), []);
  assert.deepEqual(V.pushKeysOf(null), []);
});

test("allPushKeys spans every agent", function () {
  var keys = V.allPushKeys({
    agents: [{ agentId: "a", head: HA }, { agentId: "b", head: HB, pushLog: [{ sha: HC }] }],
  });
  assert.deepEqual(keys.sort(), ["a:" + HA, "b:" + HB, "b:" + HC]);
});

test("warningIdsOf lists ids and tolerates malformed entries", function () {
  assert.deepEqual(V.warningIdsOf({ warnings: [{ id: "w2" }, { id: "w1" }, null, {}] }), ["w2", "w1"]);
  assert.deepEqual(V.warningIdsOf(null), []);
});

test("addedKeys returns only the genuinely new members, in order", function () {
  assert.deepEqual(V.addedKeys(["w1", "w2"], ["w2", "w3", "w1", "w4"]), ["w3", "w4"]);
  assert.deepEqual(V.addedKeys(null, ["w1"]), ["w1"]);
  assert.deepEqual(V.addedKeys(["w1"], null), []);
});

/* ---------- fresh (highlight) bookkeeping ---------- */

test("extendFresh adds keys with the ttl and keeps only unexpired entries", function () {
  var now = 1000;
  var next = V.extendFresh({ old: 500 /* expired */, kept: 3000 /* live */ }, ["w1", "w2"], now, 5000);
  assert.equal(next.old, undefined);
  assert.equal(next.kept, 3000);
  assert.equal(next.w1, 6000);
  assert.equal(next.w2, 6000);
});

test("isFresh / freshKeys / msUntilExpiry agree on expiry", function () {
  var expiries = { a: 1500, b: 4000 };
  assert.equal(V.isFresh(expiries, "a", 1500), false); /* expiry is exclusive */
  assert.equal(V.isFresh(expiries, "a", 1499), true);
  assert.equal(V.isFresh(expiries, "missing", 0), false);
  assert.deepEqual(V.freshKeys(expiries, 2000), ["b"]);
  assert.equal(V.msUntilExpiry(expiries, 1000), 500); /* soonest expiry wins */
  assert.equal(V.msUntilExpiry(expiries, 4000), 0);
  assert.equal(V.msUntilExpiry(null, 0), 0);
});

/* ---------- warning acknowledgements ---------- */

test("ackRows normalizes the canonical acks[] shape, oldest first", function () {
  var rows = V.ackRows({
    acks: [
      { agent: "a", head: HB, note: "second", at: "2026-10-03T13:14:05.000Z" },
      { agent: "b", head: HA, note: "first", at: "2026-10-03T13:13:30.000Z" },
    ],
  });
  assert.deepEqual(rows, [
    { agent: "b", head: HA, note: "first", at: "2026-10-03T13:13:30.000Z" },
    { agent: "a", head: HB, note: "second", at: "2026-10-03T13:14:05.000Z" },
  ]);
});

test("ackRows falls back to legacy acknowledgedBy/acknowledgedAt (no head, no note)", function () {
  var rows = V.ackRows({ acknowledgedBy: ["a", "b"], acknowledgedAt: "2026-10-03T13:27:02.000Z" });
  assert.deepEqual(rows, [
    { agent: "a", head: null, note: null, at: "2026-10-03T13:27:02.000Z" },
    { agent: "b", head: null, note: null, at: "2026-10-03T13:27:02.000Z" },
  ]);
});

test("ackRows on empty/absent acknowledgements is empty", function () {
  assert.deepEqual(V.ackRows({ acks: [] }), []);
  assert.deepEqual(V.ackRows({ acknowledgedBy: [] }), []);
  assert.deepEqual(V.ackRows({}), []);
  assert.deepEqual(V.ackRows(null), []);
});

test("ackRows keeps note-less canonical acks", function () {
  var rows = V.ackRows({ acks: [{ agent: "a", head: HA, at: "t" }] });
  assert.deepEqual(rows, [{ agent: "a", head: HA, note: null, at: "t" }]);
});

/* ---------- compact per-agent timeline ---------- */

function warning(id, pair, at, extra) {
  return Object.assign({ id: id, pair: pair, createdAt: at, status: "active" }, extra || {});
}

test("buildTimeline merges pushes, warnings for this agent, and own acks, oldest first", function () {
  var agent = {
    agentId: "a",
    head: HA,
    pushLog: [{ sha: HA, at: "2026-10-03T13:02:00.000Z", message: "first" }],
  };
  var warnings = [
    warning("w1", ["a", "b"], "2026-10-03T13:05:00.000Z", {
      acks: [
        { agent: "a", head: HA, note: "mine", at: "2026-10-03T13:06:00.000Z" },
        { agent: "b", head: HB, note: "not mine", at: "2026-10-03T13:06:30.000Z" },
      ],
    }),
    warning("w2", ["b", "c"], "2026-10-03T13:07:00.000Z"), /* other pair */
  ];
  var events = V.buildTimeline(agent, warnings);
  assert.deepEqual(
    events.map(function (e) { return e.type + "@" + e.at; }),
    ["push@2026-10-03T13:02:00.000Z", "warning@2026-10-03T13:05:00.000Z", "ack@2026-10-03T13:06:00.000Z"]
  );
  assert.equal(events[1].warningId, "w1");
  assert.equal(events[2].note, "mine");
});

test("buildTimeline falls back to one push event when there is no pushLog", function () {
  var events = V.buildTimeline({ agentId: "a", head: HA, pushes: 2, lastPushAt: "t1" }, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "push");
  assert.equal(events[0].sha, HA);
});

test("buildTimeline returns nothing without a usable agent or events", function () {
  assert.deepEqual(V.buildTimeline(null, []), []);
  assert.deepEqual(V.buildTimeline({ agentId: "a" }, []), []);
  assert.deepEqual(V.buildTimeline({ agentId: "a", pushes: 0 }, [warning("w1", ["a", "b"], null)]), []);
});

/* ---------- unprocessed (lost) pushes ---------- */

var LOST = {
  repo: "fork-x",
  ref: "refs/heads/main",
  sha: HC,
  before: HB,
  attempts: 3,
  firstAt: "2026-10-03T15:02:11.000Z",
  lastAt: "2026-10-03T15:02:12.000Z",
  lastError: "worker responded 401",
  agentId: "b",
};

test("unprocessedByAgent keeps the most recent record per agent; unknown agents bucket separately", function () {
  var map = V.unprocessedByAgent({
    unprocessedPushes: [
      LOST,
      Object.assign({}, LOST, { lastAt: "2026-10-03T15:01:00.000Z" }),
      Object.assign({}, LOST, { agentId: null, lastAt: "2026-10-03T15:03:00.000Z" }),
    ],
  });
  assert.equal(map.b.lastAt, "2026-10-03T15:02:12.000Z");
  assert.equal(map["*"].lastAt, "2026-10-03T15:03:00.000Z");
  assert.equal(V.unprocessedByAgent({}).b, undefined);
});

test("unknownHeadReason explains why the agent's true head is UNKNOWN", function () {
  var reason = V.unknownHeadReason("b", { unprocessedPushes: [LOST] });
  assert.match(reason, /push notification was lost/);
  assert.match(reason, /worker responded 401/);
  assert.match(reason, /3 delivery attempts/);
});

test("unknownHeadReason is null for agents without a lost push (and without an agent)", function () {
  var status = { unprocessedPushes: [LOST] };
  assert.equal(V.unknownHeadReason("a", status), null);
  assert.equal(V.unknownHeadReason(null, status), null);
  assert.equal(V.unknownHeadReason("b", { unprocessedPushes: [] }), null);
});
