/* Single-flight request generations and /status freshness bookkeeping for the
   Agent Branches review UI. No DOM, no fetch, so node --test loads the exact
   module the browser uses (tests/generation-guard.test.js). */
"use strict";

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root) root.AgentBranchesRequestGuard = api;
})(typeof self !== "undefined" ? self : this, function () {
  /* ---------- single-flight generations ----------
     One tracker per page. Every request begins by taking a generation
     (begin). When a request SETTLES — succeeds or fails — it records that
     first (complete) and then checks staleness: a generation older than the
     latest completed one resolves out of order and must be dropped, so a
     slow older response can never overwrite newer state (C-1385). */

  function createGenTracker() {
    var nextGen = 0;
    var latestCompletedGen = 0;
    return {
      begin: function () {
        nextGen += 1;
        return nextGen;
      },
      complete: function (gen) {
        if (gen > latestCompletedGen) latestCompletedGen = gen;
      },
      isStale: function (gen) {
        return gen < latestCompletedGen;
      },
      /* Record this request as settled; false means "a newer request already
         completed — ignore this response entirely". */
      settle: function (gen) {
        this.complete(gen);
        return !this.isStale(gen);
      },
    };
  }

  /* ---------- /status freshness (C-1385) ----------
     A failed status fetch must never be read as clean: the page keeps the
     last good data only as explicitly STALE (markStale records the error),
     and nothing — not even the absence of new warnings — may present it as
     current. Only a later successful fetch clears the stale mark. */

  function createStatusFreshness() {
    var stale = null; /* { error, atMs } while the view is stale */
    return {
      markStale: function (error, atMs) {
        stale = {
          error: error || new Error("status fetch failed"),
          atMs: typeof atMs === "number" ? atMs : Date.now(),
        };
        return stale;
      },
      markFresh: function () {
        stale = null;
      },
      isStale: function () {
        return stale !== null;
      },
      /* null while fresh; { error, atMs } while stale. */
      describe: function () {
        return stale;
      },
    };
  }

  return {
    createGenTracker: createGenTracker,
    createStatusFreshness: createStatusFreshness,
  };
});
