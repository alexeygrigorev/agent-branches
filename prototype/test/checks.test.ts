import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, RUNNER_TOKEN, sidecarCommit } from "./helpers.js";

/**
 * Trusted-runner checks via POST /checks (RUNNER_TOKEN). The vector must
 * match the current head vector exactly (stale -> 409); warnings exist only
 * for status "conflict" (codex C-1305 #1 + C-1309 #7b).
 */
async function post(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return SELF.fetch(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
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
  kind?: string;
  evidence?: string | Record<string, unknown>;
  coverage?: { tests_collected: number };
  checkedAt: string | null;
  stale: boolean;
  activeWarningIds: string[];
}

interface ChecksResponse {
  accepted: number;
  pairs: PairView[];
  createdWarnings: { id: string; status: string; reason: string; kind?: string; evidence?: string }[];
  runnerReport: {
    policy: string | { merge: string; tests: { command: string[] | null; budget_s: number } };
    coverage: string[] | { pairs_checked: number; tests_collected: number };
    accepted: number;
    vector: Record<string, string>;
  };
}

interface StatusSnapshot {
  heads: Record<string, string>;
  pairs: PairView[];
  warnings: { id: string; status: string; pair: string[]; resolvedBy?: string }[];
  lastRunnerReport: { policy: string; coverage: string[]; accepted: number; vector: Record<string, string> } | null;
}

let tagCounter = 0;

async function primedPair(): Promise<{ alpha: string; beta: string; alphaSha: string; betaSha: string }> {
  const tag = `t${String(++tagCounter).padStart(2, "0")}`;
  const alphaBody = await json<{ agentId: string; fork: { name: string } }>(
    await post("/tasks", { agent: `alpha-${tag}` }, ADMIN_TOKEN),
  );
  const betaBody = await json<{ agentId: string; fork: { name: string } }>(
    await post("/tasks", { agent: `beta-${tag}` }, ADMIN_TOKEN),
  );
  const alphaSha = await sidecarCommit(alphaBody.fork.name, "wip: alpha diverges");
  const betaSha = await sidecarCommit(betaBody.fork.name, "wip: beta diverges");
  await post("/events/push", { agent: alphaBody.agentId, sha: alphaSha }, ADMIN_TOKEN);
  await post("/events/push", { agent: betaBody.agentId, sha: betaSha }, ADMIN_TOKEN);
  return { alpha: alphaBody.agentId, beta: betaBody.agentId, alphaSha, betaSha };
}

async function currentVector(): Promise<Record<string, string>> {
  const status = await json<StatusSnapshot>(await get("/status"));
  return status.heads;
}

function pairFor<T extends { pair: string[] }>(items: T[], alpha: string, beta: string): T {
  const found = items.find((item) => item.pair.includes(alpha) && item.pair.includes(beta));
  if (!found) {
    throw new Error(`no pair for ${alpha}|${beta}`);
  }
  return found;
}

async function checks(payload: Record<string, unknown>): Promise<Response> {
  // Pre-existing tests speak the legacy wire; C-1350 requires the contract
  // field explicitly. v0.1 tests pass their own contract, overriding this.
  return post("/checks", { contract: "0.0", ...payload }, RUNNER_TOKEN);
}

describe("trusted runner checks (vector-gated, conflict-only warnings)", () => {
  it("a conflict result at the current vector creates one active warning", async () => {
    const { alpha, beta } = await primedPair();
    const response = await checks({
      vector: await currentVector(),
      policy: "merge-tree-v1",
      coverage: [`${alpha}|${beta}`],
      results: [{ pair: [alpha, beta], status: "conflict", kind: "merge-conflict", evidence: "git merge-tree exit 1" }],
    });
    expect(response.status).toBe(200);
    const body = await json<ChecksResponse>(response);
    expect(body.createdWarnings).toHaveLength(1);
    expect(body.createdWarnings[0].status).toBe("active");
    expect(body.createdWarnings[0].reason).toBe("merge-conflict");
    const view = pairFor(body.pairs, alpha, beta);
    expect(view.status).toBe("conflict");
    expect(view.kind).toBe("merge-conflict");
    expect(view.activeWarningIds).toHaveLength(1);
  });

  it("a reversed pair [b,a] at the same heads does NOT duplicate the active warning (muse-r46 D1)", async () => {
    const { alpha, beta, alphaSha, betaSha } = await primedPair();
    const first = await checks({
      vector: await currentVector(),
      policy: "merge-tree-v1",
      results: [{ pair: [alpha, beta], status: "conflict", kind: "merge-conflict" }],
    });
    expect(first.status).toBe(200);
    expect((await json<ChecksResponse>(first)).createdWarnings).toHaveLength(1);

    // Same logical conflict, submitted in the other slot order, unchanged heads.
    const reversed = await checks({
      vector: await currentVector(),
      policy: "merge-tree-v1",
      results: [{ pair: [beta, alpha], status: "conflict", kind: "merge-conflict" }],
    });
    expect(reversed.status).toBe(200);
    expect((await json<ChecksResponse>(reversed)).createdWarnings).toHaveLength(0);

    const status = await json<StatusSnapshot>(await get("/status"));
    const active = status.warnings.filter(
      (w) => w.pair.includes(alpha) && w.pair.includes(beta) && w.status === "active",
    );
    expect(active).toHaveLength(1);
    expect(active[0].pair[0] <= active[0].pair[1]).toBe(true);

    // The stored check stays fresh for the pair view regardless of order;
    // view heads are keyed by agentId (C-1350).
    const view = pairFor((await json<{ pairs: PairView[] }>(await get("/status"))).pairs, alpha, beta);
    expect(view.status).toBe("conflict");
    expect(view.stale).toBe(false);
    expect(view.activeWarningIds).toHaveLength(1);
    expect(view.heads[alpha]).toBe(alphaSha);
    expect(view.heads[beta]).toBe(betaSha);
  });

  it("rejects a stale vector with 409 and returns the current heads", async () => {
    const { alpha } = await primedPair();
    const vector = await currentVector();
    const stale = { ...vector, [alpha]: "f".repeat(40) };
    const response = await checks({ vector: stale, policy: "p", results: [] });
    expect(response.status).toBe(409);
    const body = await json<{ error: string; currentHeads: Record<string, string> }>(response);
    expect(body.error).toContain("stale vector");
    expect(body.currentHeads[alpha]).toBe(vector[alpha]);

    const missing = await checks({ vector: {}, policy: "p", results: [] });
    expect(missing.status).toBe(409);
  });

  it("clean and unknown are recorded; clean resolves an active warning at the same heads", async () => {
    const { alpha, beta } = await primedPair();
    await checks({
      vector: await currentVector(),
      policy: "p",
      results: [{ pair: [alpha, beta], status: "conflict" }],
    });
    const cleaned = await checks({
      vector: await currentVector(),
      policy: "p",
      results: [{ pair: [alpha, beta], status: "clean", evidence: "merge-tree exit 0" }],
    });
    expect((await json<ChecksResponse>(cleaned)).createdWarnings).toHaveLength(0);

    const unknown = await checks({
      vector: await currentVector(),
      policy: "p",
      results: [{ pair: [alpha, beta], status: "unknown", evidence: "worktree error" }],
    });
    const unknownBody = await json<ChecksResponse>(unknown);
    expect(pairFor(unknownBody.pairs, alpha, beta).status).toBe("unknown");

    const status = await json<StatusSnapshot>(await get("/status"));
    const resolved = status.warnings.find(
      (w) => w.pair.includes(alpha) && w.pair.includes(beta) && w.status === "invalidated",
    );
    expect(resolved?.resolvedBy).toContain("clean check");
  });

  it("records the last runner report (policy, coverage, accepted)", async () => {
    const { alpha, beta } = await primedPair();
    await checks({
      vector: await currentVector(),
      policy: "merge-tree-v1",
      coverage: [`${alpha}|${beta}`],
      results: [{ pair: [alpha, beta], status: "clean" }],
    });
    const status = await json<StatusSnapshot>(await get("/status"));
    expect(status.lastRunnerReport?.policy).toBe("merge-tree-v1");
    expect(status.lastRunnerReport?.coverage).toEqual([`${alpha}|${beta}`]);
    expect(status.lastRunnerReport?.accepted).toBe(1);
    expect(status.lastRunnerReport?.vector[alpha]).toBeTruthy();
  });

  it("advancing a head makes the pair not_checked (stale) again and invalidates the warning", async () => {
    const { alpha, beta, alphaSha } = await primedPair();
    await checks({
      vector: await currentVector(),
      policy: "p",
      results: [{ pair: [alpha, beta], status: "conflict" }],
    });
    // beta pushes a new real commit -> warning invalidated, stored check stale
    const status0 = await json<StatusSnapshot>(await get("/status"));
    const betaFork = (await json<{ agents: { agentId: string; forkName: string }[] }>(await get("/status")))
      .agents.find((a) => a.agentId === beta)!;
    const betaNext = await sidecarCommit(betaFork.forkName, "wip: beta moves on");
    const push = await json<{ invalidatedWarnings: string[]; newWarnings: unknown[] }>(
      await post("/events/push", { agent: beta, sha: betaNext }, ADMIN_TOKEN),
    );
    expect(push.invalidatedWarnings).toHaveLength(1);
    expect(push.newWarnings).toHaveLength(0);

    const status = await json<StatusSnapshot>(await get("/status"));
    const view = pairFor(status.pairs, alpha, beta);
    expect(view.status).toBe("not_checked");
    expect(view.stale).toBe(true);
    expect(view.checkedAt).toBeTruthy();
    expect(view.activeWarningIds).toEqual([]);
    expect(view.heads[alpha]).toBe(alphaSha);
    expect(view.heads[beta]).not.toBe(alphaSha);
  });

  it("rejects malformed results with 400 and missing vector with 400", async () => {
    const { alpha, beta } = await primedPair();
    const badAgent = await checks({
      vector: await currentVector(),
      policy: "p",
      results: [{ pair: [alpha, "ghost"], status: "clean" }],
    });
    expect(badAgent.status).toBe(400);
    const badStatus = await checks({
      vector: await currentVector(),
      policy: "p",
      results: [{ pair: [alpha, beta], status: "bogus" }],
    });
    expect(badStatus.status).toBe(400);
    const notChecked = await checks({
      vector: await currentVector(),
      policy: "p",
      results: [{ pair: [alpha, beta], status: "not_checked" }],
    });
    expect(notChecked.status).toBe(400);
    const noVector = await checks({ policy: "p", results: [] });
    expect(noVector.status).toBe(400);
    const noResults = await checks({ vector: await currentVector(), policy: "p" });
    expect(noResults.status).toBe(400);
  });
});

/**
 * Canonical v0.1 checks wire (codex C-1350): the typed shape produced by the
 * L3 runner's export_l1_payload (branch proto/l3-radar), reflected in
 * /status pair views with agentId-keyed heads and per-pair tests_collected
 * (the L4 review UI's clean gate: 40381f3, prototype/ui/pair-status.js).
 */
describe("canonical v0.1 checks wire (codex C-1350)", () => {
  function l3Payload(
    vector: Record<string, string>,
    alpha: string,
    beta: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      contract: "0.1",
      vector,
      policy: { merge: "git-merge-tree", tests: { command: ["pytest", "-q"], budget_s: 15 } },
      coverage: { pairs_checked: 1, tests_collected: 3 },
      results: [
        {
          pair: [alpha, beta].sort(),
          heads: { [alpha]: vector[alpha], [beta]: vector[beta] },
          status: "clean",
          kind: null,
          evidence: {
            summary: "merge-tree clean; combined test run collected 3 tests",
            files: [],
            test_output_tail: "3 passed in 1.2s",
            tests_collected: 3,
          },
        },
      ],
      ...overrides,
    };
  }

  it("accepts a real L3 export_l1_payload and reflects per-pair coverage + agentId-keyed heads in /status", async () => {
    const { alpha, beta, alphaSha, betaSha } = await primedPair();
    const response = await checks(l3Payload(await currentVector(), alpha, beta));
    expect(response.status).toBe(200);
    const body = await json<ChecksResponse>(response);
    expect(body.accepted).toBe(1);
    expect(body.createdWarnings).toHaveLength(0);
    // Typed policy/coverage are recorded verbatim on the runner report.
    expect(body.runnerReport.policy).toEqual({
      merge: "git-merge-tree",
      tests: { command: ["pytest", "-q"], budget_s: 15 },
    });
    expect(body.runnerReport.coverage).toEqual({ pairs_checked: 1, tests_collected: 3 });

    const view = pairFor((await json<{ pairs: PairView[] }>(await get("/status"))).pairs, alpha, beta);
    expect(view.status).toBe("clean");
    expect(view.stale).toBe(false);
    expect(view.heads[alpha]).toBe(alphaSha);
    expect(view.heads[beta]).toBe(betaSha);
    expect(view.coverage?.tests_collected).toBe(3);
    const evidence = view.evidence as Record<string, unknown>;
    expect(evidence.summary).toBe("merge-tree clean; combined test run collected 3 tests");
  });

  it("a v0.1 conflict creates one warning carrying the evidence summary", async () => {
    const { alpha, beta } = await primedPair();
    const vector = await currentVector();
    const payload = l3Payload(vector, alpha, beta, {
      coverage: { pairs_checked: 1, tests_collected: 0 },
      results: [
        {
          pair: [alpha, beta],
          heads: { [alpha]: vector[alpha], [beta]: vector[beta] },
          status: "conflict",
          kind: "textual",
          evidence: { summary: "src/main.ts differs", files: ["src/main.ts"] },
        },
      ],
    });
    const body = await json<ChecksResponse>(await checks(payload));
    expect(body.createdWarnings).toHaveLength(1);
    expect(body.createdWarnings[0].status).toBe("active");
    expect(body.createdWarnings[0].reason).toBe("textual");
    expect(body.createdWarnings[0].evidence).toBe("src/main.ts differs");
  });

  it("clean with tests_collected 0 records coverage 0 (L4 keeps it not-proven)", async () => {
    const { alpha, beta } = await primedPair();
    const vector = await currentVector();
    const payload = l3Payload(vector, alpha, beta, {
      coverage: { pairs_checked: 1, tests_collected: 0 },
      results: [
        {
          pair: [alpha, beta],
          heads: { [alpha]: vector[alpha], [beta]: vector[beta] },
          status: "clean",
          evidence: { summary: "merge clean, no tests ran", tests_collected: 0 },
        },
      ],
    });
    const body = await json<ChecksResponse>(await checks(payload));
    expect(body.createdWarnings).toHaveLength(0);
    const view = pairFor(body.pairs, alpha, beta);
    expect(view.status).toBe("clean");
    expect(view.coverage?.tests_collected).toBe(0);
  });

  it("a stale v0.1 vector is rejected with 409 and the current heads", async () => {
    const { alpha } = await primedPair();
    const vector = await currentVector();
    const stale = l3Payload({ ...vector, [alpha]: "f".repeat(40) }, alpha, Object.keys(vector).find((k) => k !== alpha)!);
    const response = await checks(stale);
    expect(response.status).toBe(409);
    const body = await json<{ error: string; currentHeads: Record<string, string> }>(response);
    expect(body.error).toContain("stale vector");
    expect(body.currentHeads[alpha]).toBe(vector[alpha]);
  });

  it("rejects v0.1 shape violations and undeclared legacy payloads with 400", async () => {
    const { alpha, beta } = await primedPair();
    const vector = await currentVector();

    // Legacy string shape WITHOUT the explicit contract declaration.
    const undeclared = await post(
      "/checks",
      { vector, policy: "p", results: [{ pair: [alpha, beta], status: "clean", evidence: "string" }] },
      RUNNER_TOKEN,
    );
    expect(undeclared.status).toBe(400);
    expect(((await json<{ error: string }>(undeclared)).error)).toContain("contract");

    // Unknown contract version.
    const future = await checks({ ...l3Payload(vector, alpha, beta), contract: "0.2" });
    expect(future.status).toBe(400);

    // Per-result heads disagreeing with the submitted vector.
    const wrongHeads = await checks(
      l3Payload(vector, alpha, beta, {
        results: [
          {
            pair: [alpha, beta],
            heads: { [alpha]: "a".repeat(40), [beta]: vector[beta] },
            status: "clean",
          },
        ],
      }),
    );
    expect(wrongHeads.status).toBe(400);
    expect(((await json<{ error: string }>(wrongHeads)).error)).toContain("disagree");

    // String evidence is the 0.0 shape, not valid under 0.1.
    const stringEvidence = await checks(
      l3Payload(vector, alpha, beta, {
        results: [{ pair: [alpha, beta], status: "clean", evidence: "merge-tree exit 0" }],
      }),
    );
    expect(stringEvidence.status).toBe(400);
  });
});
