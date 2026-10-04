/* Agent Branches — change story review UI (shared, vanilla JS, no frameworks).
   Two pages: index.html (overview from GET /status) and task.html?id= (change
   story from GET /tasks/:id). ?fixture=1 loads sample JSON from fixtures/.
   Live mode re-fetches GET /status every 3 s (paused while the tab is
   hidden); newly appeared warnings and pushes are highlighted for 5 s.
   Unknown safety is never rendered as safe. Requests are generation-guarded
   (C-1385): a slow older response never overwrites newer state, and a failed
   /status fetch shows a stale-error banner — never clean data. */

"use strict";

(function () {
  var params = new URLSearchParams(window.location.search);
  var FIXTURE_NAME = params.get("fixture") || "";
  var FIXTURE = !!FIXTURE_NAME;
  var API = (params.get("api") || "").replace(/\/+$/, "");
  /* Shared with node --test: pair safety (pair-status.js), view logic
     (view-logic.js — polling/highlights/acks/timeline/unprocessed pushes)
     and request bookkeeping (request-guard.js — single-flight generations
     and /status freshness, C-1385). */
  var PairLogic = window.AgentBranchesPairStatus;
  var View = window.AgentBranchesViewLogic;
  var Guard = window.AgentBranchesRequestGuard;

  /* ---------- live-update state (per page) ---------- */

  var pollTimer = null;
  var pollPausedByVisibility = false;
  var pollingStarted = false;
  var everRendered = false;
  var lastError = null;
  var lastLoadAt = null;
  var lastStatus = null;
  var lastTask = null;
  var currentTaskId = null;
  /* Single-flight bookkeeping (C-1385): every refresh() takes a generation;
     a response older than the latest settled one is dropped, so an
     out-of-order result can never overwrite newer state. statusFresh tracks
     whether the /status view currently holds fresh data or a stale error. */
  var genTracker = Guard.createGenTracker();
  var statusFresh = Guard.createStatusFreshness();
  /* Highlight bookkeeping: which warnings/pushes appeared recently.
     key -> expiry ms. The first successful load only sets the baseline. */
  var prevWarningIds = null;
  var prevPushKeys = null;
  var freshWarnings = {};
  var freshPushes = {};
  var freshTimer = null;

  /* ---------- small helpers ---------- */

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function shortSha(sha) {
    return sha ? String(sha).slice(0, 7) : "";
  }

  function shaHtml(sha) {
    if (!sha) return "<span class='muted'>none yet</span>";
    return "<code class='sha' title='" + esc(sha) + "'>" + esc(shortSha(sha)) + "</code>";
  }

  function fmtWhen(iso) {
    if (!iso) return "<span class='muted'>not recorded</span>";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "<span class='muted'>unknown time</span>";
    var abs = d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    var rel = relative(iso, d);
    return (
      "<time datetime='" + esc(iso) + "'>" + esc(abs) + "</time> <span class='muted small'>(" + esc(rel) + ")</span>"
    );
  }

  /* Plain-text time for titles/aria-labels (no markup). */
  function whenText(iso) {
    if (!iso) return "time not recorded";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "unknown time";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function relative(iso, d) {
    var s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return Math.floor(s / 86400) + " d ago";
  }

  function plainRef(ref) {
    var m = /^refs\/heads\/(.+)$/.exec(String(ref || ""));
    return m ? m[1] : ref || "not recorded";
  }

  function taskHref(taskId) {
    var keep = FIXTURE ? "&fixture=" + encodeURIComponent(FIXTURE_NAME) : "";
    return "task.html?id=" + encodeURIComponent(taskId) + keep;
  }

  function isFreshWarning(id) {
    return View.isFresh(freshWarnings, id, Date.now());
  }

  function isFreshPush(agentId, sha) {
    return View.isFresh(freshPushes, View.pushKey(agentId, sha), Date.now());
  }

  function newBadge() {
    return " <span class='badge new'>New</span>";
  }

  /* ---------- data loading ---------- */

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("request failed: HTTP " + r.status + " for " + url);
      return r.json();
    });
  }

  function fixturePath(name) {
    return FIXTURE_NAME === "1"
      ? "fixtures/" + name
      : "fixtures/" + encodeURIComponent(FIXTURE_NAME) + "-" + name;
  }

  function loadStatus() {
    return FIXTURE
      ? fetchJson(FIXTURE_NAME === "1" ? "fixtures/status.json" : "fixtures/status-" + encodeURIComponent(FIXTURE_NAME) + ".json")
      : fetchJson(API + "/status");
  }

  function loadTask(id) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
      return Promise.reject(new Error("bad task id"));
    }
    var url = FIXTURE ? fixturePath(id + ".json") : API + "/tasks/" + encodeURIComponent(id);
    return fetchJson(url);
  }

  function loadHint(isFixture) {
    return isFixture
      ? " Fixture files are loaded with fetch(), which browsers block when the page is opened directly from disk. Serve the folder over HTTP — see README-UI.md."
      : " Is the Worker running? Try: npx wrangler dev --local (from prototype/), then open this page with ?api=http://localhost:8787 if it is not served by the Worker yet.";
  }

  function showError(el, error, isFixture) {
    el.hidden = false;
    el.innerHTML = "<strong>Could not load the data.</strong> " + esc(error.message) + esc(loadHint(isFixture));
  }

  /* Explicit stale-error banner for the /status view (C-1385): while the
     latest status fetch has failed, this stays visible and the page is never
     presented as clean — safety badges and warnings may be out of date. */
  function setStatusErrorView() {
    var el = document.getElementById("status-error");
    if (!el) return;
    var stale = statusFresh.describe();
    if (!stale) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML =
      "<strong>Live status is out of date.</strong> The latest update failed (" +
      esc(stale.error.message) + "). What you see may be missing newer changes, " +
      "warnings or pair results — treat safety badges as unknown, not clean, " +
      "until the next successful update." + esc(loadHint(FIXTURE));
  }

  /* ---------- live indicator ---------- */

  function setLiveState() {
    var el = document.getElementById("live");
    if (!el) return;
    if (pollPausedByVisibility) {
      el.textContent = "Updates paused while the tab is hidden — they resume when you come back.";
      return;
    }
    var mode = FIXTURE
      ? "Demo — re-reading the fixture files"
      : "Live — fetching GET /status";
    var every = " every " + Math.round(View.POLL_MS / 1000) + " s";
    var loaded = lastLoadAt ? " · last loaded " + whenText(new Date(lastLoadAt).toISOString()) : "";
    var failed = lastError ? " · last update failed (" + lastError.message + "), retrying" : "";
    el.textContent = mode + every + loaded + failed + ".";
  }

  /* ---------- highlight bookkeeping ---------- */

  /* Diff the incoming status against the previous one; genuinely new
     warnings/pushes stay highlighted for FRESH_MS. The very first load only
     establishes the baseline, so opening the page highlights nothing. */
  function absorbFreshness(status) {
    var now = Date.now();
    var wIds = View.warningIdsOf(status);
    var pKeys = View.allPushKeys(status);
    if (prevWarningIds !== null) {
      freshWarnings = View.extendFresh(freshWarnings, View.addedKeys(prevWarningIds, wIds), now, View.FRESH_MS);
      freshPushes = View.extendFresh(freshPushes, View.addedKeys(prevPushKeys, pKeys), now, View.FRESH_MS);
    }
    prevWarningIds = wIds;
    prevPushKeys = pKeys;
  }

  /* Re-render when the next highlight expires, so the "New" mark really goes
     away after ~5 s instead of lingering until the next poll. */
  function scheduleFreshExpiry() {
    if (freshTimer) {
      clearTimeout(freshTimer);
      freshTimer = null;
    }
    var wWait = View.msUntilExpiry(freshWarnings, Date.now());
    var pWait = View.msUntilExpiry(freshPushes, Date.now());
    var wait = 0;
    if (wWait > 0 && (pWait === 0 || wWait < pWait)) wait = wWait;
    else wait = pWait;
    if (wait <= 0) return;
    freshTimer = setTimeout(function () {
      freshTimer = null;
      rerenderCurrent();
      scheduleFreshExpiry();
    }, wait + 50);
  }

  function rerenderCurrent() {
    if (!lastStatus && !lastTask) return;
    try {
      if (currentTaskId) {
        if (lastTask) renderTask(lastTask, lastStatus);
      } else if (lastStatus) {
        renderIndex(lastStatus);
      }
    } catch (e) {
      /* a re-render for highlight expiry must never break the page */
    }
  }

  /* ---------- pair safety (never guess "safe") ----------
     Pair status comes ONLY from that pair's own radar result in /status
     (status.pairs, L1 CONTRACT). A pair is "clean" only when its own
     result says clean at the CURRENT heads of both agents and the result
     records a combined test run with collected tests. A lost push for
     either agent forces not_checked (true heads unknown — never safe).
     The decision lives in pair-status.js so node --test exercises it. */

  function pairStatus(agentA, agentB, status) {
    return PairLogic.pairStatus(agentA, agentB, status);
  }

  var BADGES = {
    conflict: { cls: "conflict", label: "Conflict" },
    clean: { cls: "clean", label: "Clean — tests ran" },
    unknown: { cls: "unknown", label: "Unknown — not safe" },
    not_checked: { cls: "not_checked", label: "Not checked" },
  };

  function badgeHtml(type) {
    var b = BADGES[type];
    return "<span class='badge " + b.cls + "'>" + esc(b.label) + "</span>";
  }

  /* ---------- warning acknowledgements (POST /warnings/:id/ack) ---------- */

  function ackCellHtml(warning, viewerAgentId) {
    var rows = View.ackRows(warning);
    if (!rows.length) {
      return "<span class='muted'>Not acknowledged yet — no agent has confirmed it saw this warning.</span>";
    }
    var mine = false;
    var parts = rows.map(function (a) {
      if (viewerAgentId && a.agent === viewerAgentId) mine = true;
      var who = viewerAgentId && a.agent === viewerAgentId
        ? "<strong>" + esc(a.agent) + "</strong>"
        : "<code>" + esc(a.agent) + "</code>";
      return (
        who + " " + fmtWhen(a.at) +
        (a.head ? " <span class='muted small'>at " + shaHtml(a.head) + "</span>" : "") +
        (a.note ? "<br><span class='small'>&ldquo;" + esc(a.note) + "&rdquo;</span>" : "")
      );
    });
    var missing = viewerAgentId && !mine
      ? "<br><span class='muted small'>Not yet acknowledged by this agent.</span>"
      : "";
    return parts.join("<br>") + missing;
  }

  /* ---------- compact per-agent timeline strip ---------- */

  var TL_META = {
    push: { icon: "+", word: "push", cls: "tl-push" },
    warning: { icon: "!", word: "warning", cls: "tl-warning" },
    ack: { icon: "\u2713", word: "acknowledged", cls: "tl-ack" },
  };

  function timelineHtml(agent, warnings) {
    var events = View.buildTimeline(agent, warnings);
    if (!events.length) {
      return "<p class='muted small' style='margin:0.3rem 0 0'>No pushes, warnings or acknowledgements recorded yet.</p>";
    }
    var cap = 12;
    var shown = events.slice(-cap);
    var dropped = events.length - shown.length;
    var chips = shown.map(function (e) {
      var m = TL_META[e.type];
      var fresh = "";
      var title;
      if (e.type === "push") {
        title = "Push " + shortSha(e.sha) + (e.message ? " — " + e.message : "") + " — " + whenText(e.at);
        if (isFreshPush(agent.agentId, e.sha)) fresh = " fresh";
      } else if (e.type === "warning") {
        title =
          "Warning " + e.warningId + (e.other ? " (with " + e.other + ")" : "") +
          (e.reason ? " — " + e.reason : "") +
          (e.status && e.status !== "active" ? " — since resolved" : "") +
          " — " + whenText(e.at);
        if (isFreshWarning(e.warningId)) fresh = " fresh";
      } else {
        title =
          "Acknowledged warning " + e.warningId +
          (e.note ? " — \u201C" + e.note + "\u201D" : "") +
          " — " + whenText(e.at);
      }
      return (
        "<li class='tl " + m.cls + fresh + "' title='" + esc(title) + "'" +
        " aria-label='" + esc(m.word + ": " + title) + "'>" +
        "<span class='tl-icon' aria-hidden='true'>" + m.icon + "</span>" +
        "<span class='tl-word'>" + esc(m.word) + "</span>" +
        (fresh ? newBadge() : "") +
        "</li>"
      );
    });
    return (
      (dropped > 0 ? "<span class='muted small'>+" + dropped + " earlier</span>" : "") +
      "<ol class='timeline' aria-label='Timeline for " + esc(agent.agentId) + "'>" + chips.join("") + "</ol>" +
      "<p class='muted small timeline-legend'>+ push &middot; ! warning &middot; \u2713 acknowledged</p>"
    );
  }

  /* ---------- unprocessed (lost) pushes — the head is UNKNOWN ---------- */

  function unknownHeadHtml(reason) {
    return (
      "<span class='badge unknown'>Unknown</span> <span class='muted small'>true latest change UNKNOWN — " +
      esc(reason) +
      ". Nothing can be called clean for this agent until the push is delivered.</span>"
    );
  }

  function renderLost(status) {
    var section = document.getElementById("lost-section");
    if (!section) return;
    var recs = Array.isArray(status.unprocessedPushes) ? status.unprocessedPushes : [];
    section.hidden = recs.length === 0;
    if (!recs.length) return;
    var items = recs.map(function (r) {
      var who = r.agentId
        ? "<code>" + esc(r.agentId) + "</code>"
        : "<span class='muted'>an unknown agent</span>";
      return (
        "<li class='lost-item'>" +
        "<span class='badge unknown'>Not processed</span> A push by " + who +
        " to <code>" + esc(r.repo || "unknown repo") + "</code>, branch <code>" + esc(plainRef(r.ref)) +
        "</code>, change " + shaHtml(r.sha) + ", could not be recorded" +
        (typeof r.attempts === "number" ? " after " + esc(r.attempts) + " attempt" + (r.attempts === 1 ? "" : "s") : "") +
        (r.lastError ? " — last error: <code>" + esc(r.lastError) + "</code>" : "") +
        ". <span class='muted small'>First seen " + whenText(r.firstAt) + ", last try " + whenText(r.lastAt) + ".</span>" +
        "<p class='why muted small'>Until this push is delivered, " +
        (r.agentId ? "<code>" + esc(r.agentId) + "</code>'s" : "the agent's") +
        " true latest change is UNKNOWN, and every pair involving the agent stays not checked — never clean.</p>" +
        "</li>"
      );
    });
    document.getElementById("lost-list").innerHTML = "<ul class='lost-list'>" + items.join("") + "</ul>";
  }

  /* ---------- stale status view (C-1385) ----------
     While the /status fetch is failing, the page keeps the last good data
     only as explicitly STALE: the banner stays up and every section that
     could otherwise look clean carries this notice. */

  function staleNoteHtml(stale) {
    return (
      "<div class='notice-unknown'>" +
      "<span class='badge unknown'>Status out of date</span> " +
      "<p style='margin:0.4rem 0 0'>The live status could not be refreshed (" +
      esc(stale.error.message) +
      "), so this section comes from the last successful load and may be missing " +
      "newer events — treat it as unknown, not clean.</p></div>"
    );
  }

  /* ---------- index page ---------- */

  function renderIndex(status) {
    var stale = statusFresh.describe();
    var agents = (status.agents || []).slice().sort(function (x, y) {
      return String(x.agentId).localeCompare(String(y.agentId));
    });
    var allWarnings = status.warnings || [];

    renderLost(status);

    var canon = document.getElementById("canonical");
    canon.innerHTML =
      (stale ? staleNoteHtml(stale) : "") +
      (status.canonical && status.canonical.name
        ? "Shared starting repo: <code>" + esc(status.canonical.name) + "</code>"
        : "<span class='muted'>Shared starting repo not created yet.</span>");

    var cards = agents.map(function (ag) {
      var intent = ag.intent ? esc(ag.intent) : "<span class='muted'>Not stated yet</span>";
      var lost = View.unknownHeadReason(ag.agentId, status);
      var latest = lost
        ? unknownHeadHtml(lost)
        : shaHtml(ag.head) +
          (isFreshPush(ag.agentId, ag.head) ? newBadge() : "");
      return (
        "<article class='card" + (isFreshPush(ag.agentId, ag.head) ? " fresh" : "") + "' aria-label='Agent " + esc(ag.agentId) + "'>" +
        "<h3><code>" + esc(ag.agentId) + "</code></h3>" +
        "<p class='kv'><span>Doing:</span> " + intent + "</p>" +
        "<p class='kv'><span>Started from:</span> " +
        (ag.baseSha ? shaHtml(ag.baseSha) : "<span class='muted'>not recorded</span>") + "</p>" +
        "<p class='kv'><span>Latest change:</span> " + latest + "</p>" +
        "<p class='kv'><span>Changes pushed:</span> " + esc(ag.pushes) +
        (ag.lastPushAt ? " <span class='muted small'>(last " + fmtWhen(ag.lastPushAt) + ")</span>" : "") +
        "</p>" +
        "<div class='timeline-wrap'>" + timelineHtml(ag, allWarnings) + "</div>" +
        "<p class='actions'><a href='" + taskHref(ag.taskId) + "'>Read the change story →</a></p>" +
        "</article>"
      );
    });
    document.getElementById("agents").innerHTML =
      cards.length ? "<div class='cards'>" + cards.join("") + "</div>" : "<p class='muted'>No agent tasks yet.</p>";

    var pairs = [];
    for (var i = 0; i < agents.length; i++) {
      for (var j = i + 1; j < agents.length; j++) {
        var st = pairStatus(agents[i], agents[j], status);
        var badgeType = st.type;
        var why = st.why;
        if (stale && badgeType === "clean") {
          badgeType = "unknown";
          why =
            why +
            " · live status could not be refreshed (" +
            stale.error.message +
            "); treated as unknown, not clean";
        }
        pairs.push(
          "<li class='pair'>" +
          "<span class='who'><code>" + esc(agents[i].agentId) + "</code> ↔ <code>" + esc(agents[j].agentId) + "</code></span> " +
          badgeHtml(badgeType) +
          "<p class='why'>" + esc(why) + "</p>" +
          "</li>"
        );
      }
    }
    document.getElementById("pairs").innerHTML = pairs.length
      ? "<ul class='pair-list'>" + pairs.join("") + "</ul>"
      : "<p class='muted'>With fewer than two agents there is nothing to compare yet.</p>";

    var warnings = allWarnings;
    var rows = warnings.map(function (w) {
      var state = w.status === "active"
        ? "<span class='badge conflict'>Active</span>"
        : "<span class='badge not_checked'>Resolved</span>";
      var fresh = isFreshWarning(w.id);
      return (
        "<tr class='" + (fresh ? "fresh" : "") + "'>" +
        "<td><code>" + esc(w.id) + "</code>" + (fresh ? newBadge() : "") + "</td>" +
        "<td><code>" + esc(w.pair.join(" ↔ ")) + "</code></td>" +
        "<td>" + esc(w.reason) + "</td>" +
        "<td>" + fmtWhen(w.createdAt) + "</td>" +
        "<td>" + state + (w.invalidatedAt ? " <span class='muted small'>" + fmtWhen(w.invalidatedAt) + "</span>" : "") + "</td>" +
        "<td>" + ackCellHtml(w) + "</td>" +
        "</tr>"
      );
    });
    document.getElementById("warnings-body").innerHTML = rows.join("");
    document.getElementById("warnings-section").hidden = rows.length === 0;
  }

  /* ---------- task page ---------- */

  function renderTask(task, status) {
    var agent = task.agent || {};
    var heads = (status && status.heads) || {};
    var allWarnings = (status && status.warnings) || [];
    var stale = statusFresh.describe();
    var lost = agent.agentId ? View.unknownHeadReason(agent.agentId, status) : null;
    var currentHead = lost ? null : heads[agent.agentId] || agent.head || null;

    document.title = "Change story — " + (agent.agentId || task.taskId);

    var dl =
      "<dt>Agent</dt><dd><code>" + esc(agent.agentId || task.agentId) + "</code></dd>" +
      "<dt>Task</dt><dd><code>" + esc(task.taskId) + "</code></dd>" +
      /* intent + base live on the task record itself (GET /tasks/:id returns
         base_sha/intent at the top level; /status agents carry intent/baseSha
         for the index cards). Prefer the task-level fields, fall back to the
         agent object for older fixtures. */
      "<dt>Doing</dt><dd>" +
      ((task.intent || agent.intent) ? esc(task.intent || agent.intent) : "<span class='muted'>Not stated yet</span>") + "</dd>" +
      "<dt>Started from</dt><dd>" +
      ((task.base_sha || agent.baseSha) ? shaHtml(task.base_sha || agent.baseSha) : "<span class='muted'>Not recorded yet</span>") + "</dd>" +
      "<dt>Latest change</dt><dd>" +
      (lost ? unknownHeadHtml(lost) : shaHtml(currentHead)) + "</dd>" +
      "<dt>Working copy</dt><dd><span class='small'>own fork <code>" + esc(task.forkName || agent.forkName) +
      "</code>, branch <code>" + esc(plainRef(task.ref || agent.ref)) + "</code></span></dd>" +
      "<dt>Task created</dt><dd>" + fmtWhen(task.createdAt) + "</dd>";
    document.getElementById("task-head").innerHTML =
      (stale ? staleNoteHtml(stale) : "") + "<dl>" + dl + "</dl>";

    document.getElementById("timeline").innerHTML = timelineHtml(agent, allWarnings);

    /* Story of changes */
    var log = Array.isArray(agent.pushLog) ? agent.pushLog : [];
    var changes;
    if (lost) {
      changes =
        "<div class='notice-unknown' style='margin-bottom:0.6rem'>" +
        "<span class='badge unknown'>Unknown — not safe</span> " +
        "<p style='margin:0.4rem 0 0'>This agent's newest push could not be recorded (" + esc(lost) +
        "), so the list below may be missing its true latest change.</p></div>" +
        changesListHtml(agent, log, currentHead);
    } else {
      changes = changesListHtml(agent, log, currentHead);
    }
    document.getElementById("changes").innerHTML = changes;

    /* Warnings received by this agent */
    var mine = allWarnings.filter(function (w) {
      return Array.isArray(w.pair) && w.pair.indexOf(agent.agentId) !== -1;
    });
    var warnHtml;
    if (!mine.length) {
      /* A stale status must never read as "no warnings" (C-1385): without a
         fresh fetch, an empty list is unknown, not clean. */
      warnHtml = stale
        ? "<div class='notice-unknown'><span class='badge unknown'>Unknown</span> " +
          "<p style='margin:0.4rem 0 0'>No warnings are recorded as of the last successful load, " +
          "but the live status could not be refreshed (" + esc(stale.error.message) +
          ") — a newer warning may be missing.</p></div>"
        : "<p class='muted'>No warnings received.</p>";
    } else {
      warnHtml = mine
        .map(function (w) {
          var other = w.pair[0] === agent.agentId ? w.pair[1] : w.pair[0];
          var resolved = w.status !== "active";
          var fresh = isFreshWarning(w.id);
          return (
            "<div class='warning" + (resolved ? " resolved" : "") + (fresh ? " fresh" : "") + "'>" +
            (resolved
              ? "<span class='badge not_checked'>Resolved</span> "
              : "<span class='badge conflict'>Conflict — needs attention</span> ") +
            (fresh ? newBadge() : "") +
            "<p><strong>" + esc(w.reason) + "</strong></p>" +
            "<p class='meta'>With <code>" + esc(other) + "</code> · sent " + fmtWhen(w.createdAt) +
            (resolved ? " · went away " + fmtWhen(w.invalidatedAt) : "") + "</p>" +
            "<p class='meta'>Acknowledgement: " + ackCellHtml(w, agent.agentId) + "</p>" +
            "</div>"
          );
        })
        .join("");
    }
    document.getElementById("warnings").innerHTML = warnHtml;

    /* Test provenance */
    document.getElementById("evidence").innerHTML = evidenceHtml(agent, currentHead, lost);

    initReviewOnce(task.taskId);
  }

  function changesListHtml(agent, log, currentHead) {
    if (log.length) {
      return (
        "<ol class='changes' reversed>" +
        log
          .slice()
          .reverse()
          .map(function (p) {
            var fresh = isFreshPush(agent.agentId, p.sha);
            return (
              "<li class='" + (fresh ? "fresh" : "") + "'><span class='when'>" + fmtWhen(p.at) + "</span> — " + shaHtml(p.sha) +
              (fresh ? newBadge() : "") +
              (p.message ? "<br><span class='muted'>" + esc(p.message) + "</span>" : "") +
              "</li>"
            );
          })
          .join("") +
        "</ol>"
      );
    }
    if (agent.pushes > 0 && agent.lastPushAt) {
      var freshHead = isFreshPush(agent.agentId, agent.head);
      return (
        "<p class='" + (freshHead ? "fresh" : "") + "'>" + fmtWhen(agent.lastPushAt) + " — " + shaHtml(currentHead) +
        (freshHead ? newBadge() : "") + "</p>" +
        "<p class='muted small'>" + esc(agent.pushes) + " change" + (agent.pushes === 1 ? "" : "s") +
        " pushed in total. The full list of each change is not recorded yet.</p>"
      );
    }
    return "<p class='muted'>No changes pushed yet.</p>";
  }

  function evidenceHtml(agent, currentHead, lost) {
    var ev = agent.testEvidence;
    var stale = statusFresh.describe();
    if (lost) {
      return (
        "<div class='notice-unknown'>" +
        "<span class='badge unknown'>Unknown — not safe</span> " +
        "<p style='margin:0.4rem 0 0'>The agent's true latest change is UNKNOWN (" + esc(lost) +
        "). Whatever was tested before, there is no recorded test run for a change the server never saw — " +
        "this change is not proven safe.</p></div>"
      );
    }
    if (ev) {
      var matchesHead = !stale && (!currentHead || !ev.head || ev.head === currentHead);
      var passed = ev.exitCode === 0;
      return (
        "<div class='evidence'><dl>" +
        "<dt>Command</dt><dd><code>" + esc(ev.command) + "</code></dd>" +
        "<dt>Result</dt><dd>" +
        (passed
          ? "<span class='badge clean'>Passed</span>"
          : "<span class='badge unknown'>Failed — exit " + esc(ev.exitCode) + "</span>") +
        "</dd>" +
        "<dt>Tested change</dt><dd>" + shaHtml(ev.head) +
        (stale
          ? " <span class='muted small'>(live status unconfirmed · " + esc(stale.error.message) + ")</span>"
          : (matchesHead
            ? " <span class='muted small'>(the latest change)</span>"
            : " <span class='muted small'>(an older change, not the latest)</span>")) +
        "</dd>" +
        "<dt>When</dt><dd>" + fmtWhen(ev.at) + "</dd>" +
        "</dl>" +
        (stale
          ? "<p class='small' style='margin-bottom:0'><span class='badge unknown'>Unknown — not safe</span> " +
            "Live status could not be refreshed (" + esc(stale.error.message) + "); whether tests ran at the true current head is unknown, not safe.</p>"
          : (!matchesHead || !passed
            ? "<p class='small' style='margin-bottom:0'><span class='badge unknown'>Unknown — not safe</span> " +
              "There is no passing test run for the latest change, so this change is not proven safe.</p>"
            : "")) +
        "</div>"
      );
    }
    return (
      "<div class='notice-unknown'>" +
      "<span class='badge unknown'>Unknown — not safe</span> " +
      "<p style='margin:0.4rem 0 0'>No test run is recorded for this change. Without a test run at the " +
      "latest change, safety is unknown — this is never shown as safe.</p></div>"
    );
  }

  /* ---------- review decision (local only, per browser) ---------- */

  function reviewKey(taskId) {
    return "agent-branches-review:" + taskId;
  }

  function readReview(taskId) {
    try {
      var raw = window.localStorage.getItem(reviewKey(taskId));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeReview(taskId, value) {
    try {
      if (value === null) window.localStorage.removeItem(reviewKey(taskId));
      else window.localStorage.setItem(reviewKey(taskId), JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  var CHOICES = [
    { id: "approve", label: "Approve" },
    { id: "request_changes", label: "Request changes" },
    { id: "note", label: "Note" },
  ];

  /* The review box is interactive (buttons, note textarea): it is initialized
     exactly once per task so live re-renders never wipe what is being typed. */
  function initReviewOnce(taskId) {
    var box = document.getElementById("review");
    if (box.getAttribute("data-for") === taskId) return;
    initReview(taskId);
    box.setAttribute("data-for", taskId);
  }

  function initReview(taskId) {
    var box = document.getElementById("review");
    var current = readReview(taskId);
    var selected = current ? current.decision : null;

    var buttons = CHOICES.map(function (c) {
      return (
        "<button type='button' data-choice='" + c.id + "' aria-pressed='" + (selected === c.id) + "'>" +
        esc(c.label) + "</button>"
      );
    }).join("");

    box.innerHTML =
      "<p class='small' style='margin-top:0'>Your decision stays in this browser only for now — nothing is sent anywhere.</p>" +
      "<div class='choices' role='group' aria-label='Review decision'>" + buttons + "</div>" +
      "<label><span class='small'>Note (optional)</span><br>" +
      "<textarea id='review-note'>" + esc(current && current.note ? current.note : "") + "</textarea></label> " +
      "<p><button type='button' class='primary' id='review-save'>Save decision</button> " +
      "<button type='button' id='review-clear'>Clear</button></p>" +
      "<p class='saved muted' id='review-saved' role='status' aria-live='polite'></p>";

    var choice = selected;
    box.querySelectorAll("[data-choice]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        choice = btn.getAttribute("data-choice");
        box.querySelectorAll("[data-choice]").forEach(function (b) {
          b.setAttribute("aria-pressed", String(b === btn));
        });
      });
    });

    var savedEl = box.querySelector("#review-saved");
    function showSaved(msg) {
      savedEl.textContent = msg;
    }

    box.querySelector("#review-save").addEventListener("click", function () {
      if (!choice) {
        showSaved("Pick a decision first: Approve, Request changes, or Note.");
        return;
      }
      var label = (CHOICES.filter(function (c) { return c.id === choice; })[0] || {}).label;
      var ok = writeReview(taskId, { decision: choice, note: box.querySelector("#review-note").value, at: new Date().toISOString() });
      showSaved(ok
        ? "Saved in this browser just now: " + label + "."
        : "Could not save — this browser blocks local storage.");
    });

    box.querySelector("#review-clear").addEventListener("click", function () {
      writeReview(taskId, null);
      choice = null;
      box.querySelectorAll("[data-choice]").forEach(function (b) { b.setAttribute("aria-pressed", "false"); });
      box.querySelector("#review-note").value = "";
      showSaved("Cleared.");
    });

    if (current && current.at) {
      var cl = (CHOICES.filter(function (c) { return c.id === current.decision; })[0] || {}).label;
      showSaved("Saved in this browser " + fmtWhen(current.at) + ": " + (cl || current.decision) + ".");
    }
  }

  /* ---------- polling (GET /status every 3 s, paused when hidden) ---------- */

  /* A status result is never swallowed into null (C-1385): failures arrive
     as {ok:false, error} and are surfaced, not hidden. */
  function statusOk(status) {
    if (!status) return { ok: false, error: new Error("server returned an empty status document") };
    return { ok: true, status: status };
  }

  function statusFailed(error) {
    return { ok: false, error: error };
  }

  function refresh() {
    var gen = genTracker.begin();
    var p = currentTaskId
      ? Promise.all([loadTask(currentTaskId), loadStatus().then(statusOk, statusFailed)]).then(function (r) {
          return { task: r[0], statusResult: r[1] };
        })
      : loadStatus().then(statusOk, statusFailed).then(function (statusResult) {
          return { task: null, statusResult: statusResult };
        });
    return p.then(
      function (r) {
        /* Single-flight guard (C-1385): when this response settles after a
           newer request already has, it is out of order — drop it instead of
           overwriting newer state. */
        if (!genTracker.settle(gen)) return;

        if (!r.statusResult.ok) {
          /* /status failed: record the error, mark the status view stale with
             the explicit banner, and never render the page as clean. */
          statusFresh.markStale(r.statusResult.error);
          lastError = r.statusResult.error;
          setStatusErrorView();
          if (currentTaskId && r.task) {
            lastTask = r.task; /* the task story loaded; render it marked stale */
            renderTask(lastTask, lastStatus);
            everRendered = true;
          } else if (!currentTaskId && lastStatus) {
            /* Index view re-render marked stale (C-1399): downgrades clean badges to unknown */
            renderIndex(lastStatus);
            everRendered = true;
          }
          return;
        }

        statusFresh.markFresh();
        lastError = null;
        lastStatus = r.statusResult.status;
        if (currentTaskId) lastTask = r.task;
        lastLoadAt = Date.now();
        absorbFreshness(lastStatus);
        setStatusErrorView();
        if (currentTaskId) renderTask(lastTask, lastStatus);
        else renderIndex(lastStatus);
        everRendered = true;
        scheduleFreshExpiry();
      },
      function (e) {
        /* A late failure from an already-outdated request is dropped too. */
        if (!genTracker.settle(gen)) return;
        throw e; /* doRefresh records lastError and shows the load banner */
      }
    );
  }

  function doRefresh(first) {
    return refresh().then(
      function () {
        setLiveState();
      },
      function (e) {
        lastError = e;
        if (first && !everRendered) {
          showError(document.getElementById("error"), e, FIXTURE);
        }
        setLiveState();
      }
    );
  }

  function handleVisibility() {
    if (document.hidden) {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      pollPausedByVisibility = true;
    } else {
      pollPausedByVisibility = false;
      if (!pollTimer) {
        pollTimer = setInterval(function () { doRefresh(false); }, View.POLL_MS);
      }
      doRefresh(false); /* catch up immediately when coming back */
    }
    setLiveState();
  }

  function startPolling() {
    if (pollingStarted) return;
    pollingStarted = true;
    document.addEventListener("visibilitychange", handleVisibility);
    if (document.hidden) {
      pollPausedByVisibility = true;
      return;
    }
    pollTimer = setInterval(function () { doRefresh(false); }, View.POLL_MS);
  }

  /* ---------- boot ---------- */

  window.AgentBranchesUI = {
    FIXTURE: FIXTURE,
    bootIndex: function () {
      if (FIXTURE) document.getElementById("demo-banner").hidden = false;
      var loading = document.getElementById("loading");
      currentTaskId = null;
      doRefresh(true).then(function () { loading.hidden = true; });
      startPolling();
      setLiveState();
    },
    bootTask: function () {
      if (FIXTURE) document.getElementById("demo-banner").hidden = false;
      var loading = document.getElementById("loading");
      var id = params.get("id");
      if (!id) {
        loading.hidden = true;
        showError(
          document.getElementById("error"),
          new Error("No task id given. Open this page from the overview, or add ?id=task-0001."),
          FIXTURE
        );
        return;
      }
      currentTaskId = id;
      doRefresh(true).then(function () { loading.hidden = true; });
      startPolling();
      setLiveState();
    },
  };
})();
