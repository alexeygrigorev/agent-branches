import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, RUNNER_TOKEN, SIDECAR_TOKEN, SIDECAR_URL, sidecarCommit } from "./helpers.js";

/**
 * codex C-1357: a git push whose post-receive callback to the Worker failed
 * (sidecar recorded it unprocessed after bounded retries) must NOT leave a
 * stale stored check presenting as current. GET /status surfaces the
 * unprocessed push and shows the pair as not_checked with a reason — never
 * clean — until the record is superseded/cleared.
 *
 * The vitest sidecar intentionally runs without SIDECAR_NOTIFY_URL (pushes
 * are reported directly in tests), so the ledger is driven through the
 * bearer-gated dev/test endpoints (POST inject, DELETE clear), the same
 * helpers documented beside POST /api/repos/:name/commits.
 */
async function post(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return SELF.fetch(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function get(path: string): Promise<Response> {
  // C1462 Task 1: reads are bearer-gated; the suite reads as admin.
  return SELF.fetch(`http://localhost${path}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface PairView {
  pair: string[];
  heads: Record<string, string>;
  status: string;
  evidence?: string | Record<string, unknown>;
  coverage?: { tests_collected: number };
  stale: boolean;
  unprocessedReason?: string;
}

interface StatusSnapshot {
  heads: Record<string, string>;
  pairs: PairView[];
  unprocessedPushes: {
    agentId: string | null;
    fork: string;
    ref: string;
    sha: string;
    attempts: number;
    lastError: string;
  }[];
}

let tagCounter = 0;

async function sidecarApi(path: string, init: RequestInit): Promise<{ status: number }> {
  const res = await fetch(`${SIDECAR_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SIDECAR_TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status };
}

describe("unprocessed-push surfacing (codex C-1357)", () => {
  it("a stored clean check stops presenting as current while an agent's push is unprocessed", async () => {
    const tag = `u${String(++tagCounter).padStart(2, "0")}`;
    const alpha = await json<{ agentId: string; fork: { name: string } }>(
      await post("/tasks", { agent: `alpha-${tag}` }, ADMIN_TOKEN),
    );
    const beta = await json<{ agentId: string; fork: { name: string } }>(
      await post("/tasks", { agent: `beta-${tag}` }, ADMIN_TOKEN),
    );
    const alphaSha = await sidecarCommit(alpha.fork.name, "wip: alpha work");
    const betaSha = await sidecarCommit(beta.fork.name, "wip: beta work");
    await post("/events/push", { agent: alpha.agentId, sha: alphaSha }, ADMIN_TOKEN);
    await post("/events/push", { agent: beta.agentId, sha: betaSha }, ADMIN_TOKEN);

    // A clean check with positive coverage at the current heads — the pair
    // would normally present as verified-clean to the L4 UI.
    const vector = (await json<StatusSnapshot>(await get("/status"))).heads;
    const checks = await post(
      "/checks",
      {
        contract: "0.1",
        vector,
        policy: { merge: "git-merge-tree", tests: { command: ["pytest", "-q"], budget_s: 15 } },
        coverage: { pairs_checked: 1, tests_collected: 4 },
        results: [
          {
            pair: [alpha.agentId, beta.agentId].sort(),
            heads: { [alpha.agentId]: alphaSha, [beta.agentId]: betaSha },
            status: "clean",
            kind: "test",
            evidence: { summary: "4 collected, all pass", files: [], test_output_tail: "4 passed", tests_collected: 4 },
          },
        ],
      },
      RUNNER_TOKEN,
    );
    expect(checks.status).toBe(200);
    const beforePair = (await json<StatusSnapshot>(await get("/status"))).pairs.find(
      (p) => p.pair.includes(alpha.agentId) && p.pair.includes(beta.agentId),
    );
    expect(beforePair?.status).toBe("clean");
    expect(beforePair?.coverage).toEqual({ tests_collected: 4 });

    // beta's push callback fails at the Worker: the sidecar records the push
    // unprocessed (the Worker's known head for beta is now stale/unknown).
    const injected = await sidecarApi("/api/notify-state", {
      method: "POST",
      body: JSON.stringify({
        repo: beta.fork.name,
        ref: "refs/heads/main",
        sha: "a".repeat(40),
        before: betaSha,
        attempts: 3,
        lastError: "worker responded 401",
      }),
    });
    expect(injected.status).toBe(201);

    const status = await json<StatusSnapshot>(await get("/status"));
    // Surfaced at the top level with the resolved agent.
    const record = status.unprocessedPushes.find((r) => r.agentId === beta.agentId);
    expect(record).toBeTruthy();
    expect(record?.sha).toBe("a".repeat(40));
    expect(record?.lastError).toContain("401");

    // ...and the pair NO LONGER presents as clean at current heads: the true
    // head of beta is unknown, so the pair is not_checked with a reason.
    const pair = status.pairs.find(
      (p) => p.pair.includes(alpha.agentId) && p.pair.includes(beta.agentId),
    );
    expect(pair?.status).toBe("not_checked");
    expect(pair?.status).not.toBe("clean");
    expect(pair?.coverage).toBeUndefined();
    expect(pair?.unprocessedReason).toContain("unprocessed");
    expect(pair?.stale).toBe(true);

    // Recovery: the record is superseded/cleared sidecar-side; the previously
    // stored clean check is fresh again.
    const cleared = await sidecarApi("/api/notify-state", { method: "DELETE" });
    expect(cleared.status).toBe(200);
    const recovered = await json<StatusSnapshot>(await get("/status"));
    expect(recovered.unprocessedPushes).toHaveLength(0);
    const recoveredPair = recovered.pairs.find(
      (p) => p.pair.includes(alpha.agentId) && p.pair.includes(beta.agentId),
    );
    expect(recoveredPair?.status).toBe("clean");
    expect(recoveredPair?.coverage).toEqual({ tests_collected: 4 });
    expect(recoveredPair?.unprocessedReason).toBeUndefined();
  });
});
