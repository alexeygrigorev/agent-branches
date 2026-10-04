/* Run the review UI's exact pair-safety decision (prototype/ui/pair-status.js)
   against a live /status JSON, so the run's assertions can verify what the UI
   badges show without eyeballing pixels: node check-ui-pairs.cjs <status.json>
   prints {"a|b": "<badge type>", ...} for every agent pair. The badge text in
   the UI maps 1:1 from the badge type (BADGES table in ui.js:
   conflict -> "Conflict", clean -> "Clean — tests ran", ...). */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const logic = require(path.join(__dirname, "..", "prototype", "ui", "pair-status.js"));

const status = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const agents = (status.agents || []).slice().sort((a, b) => String(a.agentId).localeCompare(String(b.agentId)));

const out = {};
for (let i = 0; i < agents.length; i++) {
  for (let j = i + 1; j < agents.length; j++) {
    const verdict = logic.pairStatus(agents[i], agents[j], status);
    out[agents[i].agentId + "|" + agents[j].agentId] = verdict.type;
  }
}
console.log(JSON.stringify(out, null, 2));
