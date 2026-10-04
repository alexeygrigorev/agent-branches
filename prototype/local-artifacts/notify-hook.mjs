#!/usr/bin/env node
/**
 * post-receive hook body (codex C-1309 #7a).
 *
 * Installed by the sidecar into every bare repo as hooks/post-receive.
 * Git feeds "<old-sha> <new-sha> <ref>" lines on stdin; each becomes a POST
 * to the sidecar's internal /hooks/push endpoint, which forwards it to the
 * Worker's POST /events/push. Notify failures never fail the git push.
 *
 * Usage: node notify-hook.mjs <internalNotifyUrl> <repoName>
 */
import { request as httpRequest } from "node:http";

const [target, repo] = process.argv.slice(2);

function post(push) {
  const payload = Buffer.from(JSON.stringify(push));
  return new Promise((resolvePost) => {
    const req = httpRequest(
      target,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": payload.length },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolvePost(true));
      },
    );
    req.on("error", (error) => {
      console.error(`[notify-hook] ${repo}: ${error.message}`);
      resolvePost(false);
    });
    req.end(payload);
  });
}

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", async () => {
  const pushes = data
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [before, after, ref] = line.split(/\s+/);
      return { repo, ref, before, after };
    });
  for (const push of pushes) {
    await post(push);
  }
  process.exit(0);
});
process.stdin.on("error", () => process.exit(0));
