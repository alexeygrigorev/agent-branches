/* Pure view logic for the Agent Branches review UI: live-update bookkeeping
   (poll + 5 s "newly appeared" highlights), warning acknowledgements from
   POST /warnings/:id/ack, the compact per-agent timeline, and unprocessed
   (lost) push records from GET /status (CONTRACT 0.1.3 silent-callback guard).
   No DOM, no fetch, so node --test loads the exact module the browser uses.
   Safety decisions stay in pair-status.js. */
"use strict";

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root) root.AgentBranchesViewLogic = api;
})(typeof self !== "undefined" ? self : this, function () {
  var POLL_MS = 3000; /* live update cadence for GET /status */
  var FRESH_MS = 5000; /* how long a newly appeared warning/push stays highlighted */

  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }

  /* ---------- keys of things that can "newly appear" ---------- */

  function pushKey(agentId, sha) {
    return agentId + ":" + sha;
  }

  /* Every push we can see for one agent: the push log when the server
     provides one, plus the current head (live /status carries only the head,
     so a head change is the observable "new push" there). */
  function pushKeysOf(agent) {
    var id = agent && agent.agentId;
    if (!id) return [];
    var keys = {};
    asArray(agent.pushLog).forEach(function (p) {
      if (p && p.sha) keys[pushKey(id, p.sha)] = true;
    });
    if (agent.head) keys[pushKey(id, agent.head)] = true;
    return Object.keys(keys);
  }

  function allPushKeys(status) {
    var keys = {};
    asArray(status && status.agents).forEach(function (a) {
      pushKeysOf(a).forEach(function (k) {
        keys[k] = true;
      });
    });
    return Object.keys(keys);
  }

  function warningIdsOf(status) {
    return asArray(status && status.warnings)
      .map(function (w) {
        return w && w.id;
      })
      .filter(function (id) {
        return id != null;
      });
  }

  /* Members of `next` that were not in `prev` (arrays of strings). */
  function addedKeys(prev, next) {
    var seen = {};
    asArray(prev).forEach(function (k) {
      if (k != null) seen[k] = true;
    });
    return asArray(next).filter(function (k) {
      return k != null && !seen[k];
    });
  }

  /* ---------- fresh (highlight) bookkeeping: key -> expiry ms ----------
     First load only ever establishes the baseline: nothing is highlighted
     just for being on the page when it opens. */

  function extendFresh(expiries, keys, nowMs, ttlMs) {
    var next = {};
    Object.keys(expiries || {}).forEach(function (k) {
      if (expiries[k] > nowMs) next[k] = expiries[k];
    });
    asArray(keys).forEach(function (k) {
      next[k] = nowMs + ttlMs;
    });
    return next;
  }

  function isFresh(expiries, key, nowMs) {
    return !!(expiries && expiries[key] > nowMs);
  }

  function freshKeys(expiries, nowMs) {
    return Object.keys(expiries || {}).filter(function (k) {
      return expiries[k] > nowMs;
    });
  }

  /* Smallest remaining time until some highlight expires (so a re-render can
     drop it promptly); 0 when nothing is fresh. */
  function msUntilExpiry(expiries, nowMs) {
    var min = 0;
    Object.keys(expiries || {}).forEach(function (k) {
      var wait = expiries[k] - nowMs;
      if (wait > 0 && (min === 0 || wait < min)) min = wait;
    });
    return min;
  }

  /* ---------- warning acknowledgements (POST /warnings/:id/ack) ----------
     Canonical WarningRecord shape is `acks: [{agent, head, note?, at}]`;
     the legacy `acknowledgedBy[]` + `acknowledgedAt` pair still renders
     (no head, no note). Rows are normalized and sorted oldest first. */

  function ackRows(warning) {
    if (!warning) return [];
    if (Array.isArray(warning.acks)) {
      return warning.acks
        .filter(function (a) {
          return a && a.agent;
        })
        .map(function (a) {
          return {
            agent: String(a.agent),
            head: a.head || null,
            note: a.note || null,
            at: a.at || null,
          };
        })
        .sort(function (x, y) {
          return String(x.at).localeCompare(String(y.at));
        });
    }
    var at = warning.acknowledgedAt || null;
    return asArray(warning.acknowledgedBy)
      .filter(Boolean)
      .map(function (agent) {
        return { agent: String(agent), head: null, note: null, at: at };
      });
  }

  /* ---------- compact per-agent timeline: pushes, warnings, acks ----------
     One event per push / warning sent to this agent / acknowledgement this
     agent gave, sorted oldest first. Events without a usable time are
     dropped rather than guessed. */

  function buildTimeline(agent, warnings) {
    var id = agent && agent.agentId;
    if (!id) return [];
    var events = [];
    var log = asArray(agent.pushLog);
    log.forEach(function (p) {
      if (p && p.sha) {
        events.push({ type: "push", at: p.at || null, sha: p.sha, message: p.message || null });
      }
    });
    if (!log.length && agent.pushes > 0 && agent.lastPushAt) {
      events.push({ type: "push", at: agent.lastPushAt, sha: agent.head || null, message: null });
    }
    asArray(warnings).forEach(function (w) {
      if (!w || !Array.isArray(w.pair) || w.pair.indexOf(id) === -1) return;
      var other = w.pair[0] === id ? w.pair[1] : w.pair[0];
      events.push({
        type: "warning",
        at: w.createdAt || null,
        warningId: w.id,
        other: other,
        reason: w.reason || null,
        status: w.status || null,
      });
      ackRows(w).forEach(function (a) {
        if (a.agent !== id) return;
        events.push({
          type: "ack",
          at: a.at,
          warningId: w.id,
          note: a.note,
          head: a.head,
        });
      });
    });
    return events
      .filter(function (e) {
        return e.at;
      })
      .sort(function (x, y) {
        return String(x.at).localeCompare(String(y.at));
      });
  }

  /* ---------- unprocessed (lost) pushes — CONTRACT 0.1.3 ----------
     While a fork has an unprocessed push record, its agent's true head is
     UNKNOWN: the recorded head may be behind reality and no stored pair
     result may present as current. */

  /* agentId -> the most recent record (by lastAt). Records whose agent could
     not be resolved collect under "*" and are shown, but never attributed. */
  function unprocessedByAgent(status) {
    var map = {};
    asArray(status && status.unprocessedPushes).forEach(function (r) {
      if (!r) return;
      var key = r.agentId || "*";
      var prev = map[key];
      if (!prev || String(r.lastAt || "") > String(prev.lastAt || "")) map[key] = r;
    });
    return map;
  }

  /* A human-readable reason why this agent's latest change is UNKNOWN,
     or null when the agent has no lost push. */
  function unknownHeadReason(agentId, status) {
    if (!agentId) return null;
    var rec = unprocessedByAgent(status)[agentId];
    if (!rec) return null;
    var bits = ["a push notification was lost"];
    if (rec.lastError) bits.push(String(rec.lastError));
    if (typeof rec.attempts === "number") {
      bits.push(rec.attempts + " delivery attempt" + (rec.attempts === 1 ? "" : "s"));
    }
    if (rec.lastAt) bits.push("last try " + rec.lastAt);
    return bits.join(" — ");
  }

  return {
    POLL_MS: POLL_MS,
    FRESH_MS: FRESH_MS,
    pushKey: pushKey,
    pushKeysOf: pushKeysOf,
    allPushKeys: allPushKeys,
    warningIdsOf: warningIdsOf,
    addedKeys: addedKeys,
    extendFresh: extendFresh,
    isFresh: isFresh,
    freshKeys: freshKeys,
    msUntilExpiry: msUntilExpiry,
    ackRows: ackRows,
    buildTimeline: buildTimeline,
    unprocessedByAgent: unprocessedByAgent,
    unknownHeadReason: unknownHeadReason,
  };
});
