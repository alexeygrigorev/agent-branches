import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, RUNNER_TOKEN, sidecarCommit } from "./helpers.js";

/**
 * Canonical CONTRACT v0.1 checks wire (codex C-1350). Fixtures mirror the
 * ACTUAL output of L3's radar/engine.py export_l1_payload() (branch
 * origin/proto/l3-radar @ 2b928fc) — including its evidence merging — so the
 * tests exercise what the real trusted runner sends, not a prose sketch.
 *
 * Exporter behaviour mirrored below:
 * - top-level vector/pairs sorted; policy {merge, tests:{command, budget_s}};
 * - coverage {pairs_checked, tests_collected} where tests_collected is the
 *   SUM of the numeric evidence.tests_collected values (per-pair counts
 *   travel INSIDE each result's evidence);
 * - per result: pair sorted, heads keyed by agentId, kind "textual"|"test"|null,
 *   evidence always gains a string `summary` (from summary/details/error/
 *   reason), `files` (from files/conflicting_files/overlapping_files) and
 *   `test_output_tail` (from stderr/stdout) when absent.
 */
interface L3PairInput {
  pair: [string, string];
  heads: Record<string, string>;
  status: string;
  kind?: string | null;
  evidence?: Record<string, unknown>;
}

function l3ExportL1Payload(vector: Record<string, string>, pairs: L3PairInput[]): Record<string, unknown> {
  const sortedVector: Record<string, string> = {};
  for (const key of Object.keys(vector).sort()) sortedVector[key] = vector[key];
  const results = pairs
    .map((p) => {
      const pair = [...p.pair].sort();
      const heads: Record<string, string> = {};
      for (const agent of pair) heads[agent] = p.heads[agent];
      const evidence: Record<string, unknown> = { ...(p.evidence ?? {}) };
      evidence.summary =
        evidence.summary ??
        evidence.details ??
        evidence.error ??
        evidence.reason ??
        `Merge status: ${p.status}`;
      evidence.files = evidence.files ?? evidence.conflicting_files ?? evidence.overlapping_files ?? [];
      if (evidence.stderr !== undefined || evidence.stdout !== undefined) {
        evidence.test_output_tail = String(evidence.stderr ?? evidence.stdout).slice(-1000);
      }
      return { pair, heads, status: p.status, kind: p.kind ?? null, evidence };
    })
    .sort((a, b) => (a.pair[0] < b.pair[0] ? -1 : a.pair[0] > b.pair[0] ? 1 : a.pair[1] < b.pair[1] ? -1 : 1));
  const testsCollected = results.reduce(
    (sum, r) => sum + (typeof r.evidence.tests_collected === "number" ? r.evidence.tests_collected : 0),
    0,
  );
  return {
    contract: "0.1",
    vector: sortedVector,
    policy: {
      merge: "git-merge-tree",
      tests: { command: ["python3", "-m", "unittest", "discover"], budget_s: 15.0 },
    },
    coverage: { pairs_checked: results.length, tests_collected: testsCollected },
    results,
  };
}

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
  kind?: string;
  evidence?: string | Record<string, unknown>;
  coverage?: { tests_collected?: number };
  checkedAt: string | null;
  stale: boolean;
  activeWarningIds: string[];
}

interface ChecksResponse {
  accepted: number;
  pairs: PairView[];
  createdWarnings: { id: string; status: string; reason: string; evidence?: string }[];
}

interface StatusSnapshot {
  heads: Record<string, string>;
  pairs: PairView[];
  warnings: { id: string; status: string; pair: string[]; reason: string; evidence?: string; resolvedBy?: string }[];
  lastRunnerReport: {
    policy: string | Record<string, unknown>;
    coverage: string[] | Record<string, unknown>;
    accepted: number;
    vector: Record<string, string>;
  } | null;
}

let tagCounter = 0;

async function primedPair(): Promise<{ alpha: string; beta: string; alphaSha: string; betaSha: string }> {
  const tag = `w${String(++tagCounter).padStart(2, "0")}`;
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
  return post("/checks", payload, RUNNER_TOKEN);
}

describe("canonical v0.1 checks wire (codex C-1350)", () => {
  it("accepts a real L3-shaped clean payload and exposes per-pair coverage + agentId-keyed heads", async () => {
    const { alpha, beta, alphaSha, betaSha } = await primedPair();
    const vector = await currentVector();
    const payload = l3ExportL1Payload(vector, [
      {
        pair: [alpha, beta],
        heads: { [alpha]: alphaSha, [beta]: betaSha },
        status: "clean",
        evidence: {
          exit_code: 0,
          tests_collected: 5,
          details: "Ran 5 tests in 0.05s OK",
          stdout: "Ran 5 tests in 0.05s\nOK",
        },
      },
    ]);
    const response = await checks(payload);
    expect(response.status).toBe(200);
    const body = await json<ChecksResponse>(response);
    expect(body.accepted).toBe(1);
    expect(body.createdWarnings).toHaveLength(0);

    const view = pairFor(body.pairs, alpha, beta);
    expect(view.status).toBe("clean");
    // The L4 clean gate (prototype/ui/pair-status.js) reads exactly these:
    expect(view.coverage).toEqual({ tests_collected: 5 });
    expect(view.heads).toEqual({ [alpha]: alphaSha, [beta]: betaSha });
    const evidence = view.evidence as Record<string, unknown>;
    expect(evidence.summary).toBe("Ran 5 tests in 0.05s OK");
    expect(evidence.test_output_tail).toBe("Ran 5 tests in 0.05s\nOK");
    expect(view.stale).toBe(false);

    const status = await json<StatusSnapshot>(await get("/status"));
    const statusView = pairFor(status.pairs, alpha, beta);
    expect(statusView.status).toBe("clean");
    expect(statusView.coverage).toEqual({ tests_collected: 5 });
    expect(statusView.heads[alpha]).toBe(alphaSha);
    expect(statusView.heads[beta]).toBe(betaSha);
    // Typed policy/coverage are recorded verbatim on the runner report.
    expect(status.lastRunnerReport?.policy).toEqual({
      merge: "git-merge-tree",
      tests: { command: ["python3", "-m", "unittest", "discover"], budget_s: 15 },
    });
    expect(status.lastRunnerReport?.coverage).toEqual({ pairs_checked: 1, tests_collected: 5 });
    expect(status.lastRunnerReport?.accepted).toBe(1);
  });

  it("L3 textual-conflict payload creates one warning; the evidence summary becomes the warning text", async () => {
    const { alpha, beta, alphaSha, betaSha } = await primedPair();
    const payload = l3ExportL1Payload(await currentVector(), [
      {
        pair: [alpha, beta],
        heads: { [alpha]: alphaSha, [beta]: betaSha },
        status: "conflict",
        kind: "textual",
        evidence: { conflicting_files: ["app.py"], details: "Merge conflict in app.py" },
      },
    ]);
    const response = await checks(payload);
    expect(response.status).toBe(200);
    const body = await json<ChecksResponse>(response);
    expect(body.createdWarnings).toHaveLength(1);
    expect(body.createdWarnings[0].status).toBe("active");
    expect(body.createdWarnings[0].reason).toBe("textual");
    expect(body.createdWarnings[0].evidence).toBe("Merge conflict in app.py");

    const view = pairFor(body.pairs, alpha, beta);
    expect(view.status).toBe("conflict");
    expect(view.kind).toBe("textual");
    expect(view.activeWarningIds).toHaveLength(1);
    // No test run happened for this pair, so there is no per-pair coverage.
    expect(view.coverage).toBeUndefined();
  });

  it("unknown stays unknown through the typed wire (no warning, no coverage)", async () => {
    const { alpha, beta, alphaSha, betaSha } = await primedPair();
    const payload = l3ExportL1Payload(await currentVector(), [
      {
        pair: [alpha, beta],
        heads: { [alpha]: alphaSha, [beta]: betaSha },
        status: "unknown",
        evidence: { error: "timeout", details: "Process timed out after 15s", stderr: "TimeoutExpired" },
      },
    ]);
    const response = await checks(payload);
    expect(response.status).toBe(200);
    const body = await json<ChecksResponse>(response);
    expect(body.createdWarnings).toHaveLength(0);
    const view = pairFor(body.pairs, alpha, beta);
    expect(view.status).toBe("unknown");
    expect(view.coverage).toBeUndefined();
    const status = await json<StatusSnapshot>(await get("/status"));
    // The DO is shared per test file: scope warning assertions to THIS pair.
    expect(status.warnings.filter((w) => w.pair.includes(alpha) && w.pair.includes(beta))).toHaveLength(0);
  });

  it("a typed payload with a stale vector is still 409 with the current heads", async () => {
    const { alpha, beta, alphaSha, betaSha } = await primedPair();
    const vector = await currentVector();
    const stale = { ...vector, [alpha]: "f".repeat(40) };
    const payload = l3ExportL1Payload(stale, [
      { pair: [alpha, beta], heads: { [alpha]: alphaSha, [beta]: betaSha }, status: "clean" },
    ]);
    const response = await checks(payload);
    expect(response.status).toBe(409);
    const body = await json<{ error: string; currentHeads: Record<string, string> }>(response);
    expect(body.error).toContain("stale vector");
    expect(body.currentHeads[alpha]).toBe(vector[alpha]);
  });

  it("a legacy string payload is still accepted through the documented contract 0.0 adapter", async () => {
    const { alpha, beta, alphaSha, betaSha } = await primedPair();
    const response = await checks({
      contract: "0.0",
      vector: await currentVector(),
      policy: "merge-tree-v1",
      coverage: [`${alpha}|${beta}`],
      results: [{ pair: [alpha, beta], status: "conflict", kind: "merge-conflict", evidence: "git merge-tree exit 1" }],
    });
    expect(response.status).toBe(200);
    const body = await json<ChecksResponse>(response);
    expect(body.createdWarnings).toHaveLength(1);
    const view = pairFor(body.pairs, alpha, beta);
    expect(view.status).toBe("conflict");
    expect(view.evidence).toBe("git merge-tree exit 1");
    expect(view.coverage).toBeUndefined();
    // The status view shape is the same for both adapters: heads keyed by agentId.
    expect(view.heads[alpha]).toBe(alphaSha);

    const status = await json<StatusSnapshot>(await get("/status"));
    expect(status.lastRunnerReport?.policy).toBe("merge-tree-v1");
    expect(status.lastRunnerReport?.coverage).toEqual([`${alpha}|${beta}`]);
  });

  it("a payload without a contract field is rejected: callers must declare the wire (C-1350)", async () => {
    const { alpha, beta, alphaSha } = await primedPair();
    const legacy = {
      vector: await currentVector(),
      policy: "merge-tree-v1",
      results: [{ pair: [alpha, beta], status: "conflict", evidence: "git merge-tree exit 1" }],
    };
    const response = await checks(legacy);
    expect(response.status).toBe(400);
    const body = await json<{ error: string }>(response);
    expect(body.error).toContain("contract");
    // Rejecting the payload must not mutate state: no warning, no recorded check
    // (scoped to this pair — the DO is shared across the file's tests).
    const status = await json<StatusSnapshot>(await get("/status"));
    expect(status.warnings.filter((w) => w.pair.includes(alpha) && w.pair.includes(beta))).toHaveLength(0);
    expect(pairFor(status.pairs, alpha, beta).status).toBe("not_checked");
    expect(status.heads[alpha]).toBe(alphaSha);
  });

  it("an unknown contract version is rejected (explicit dispatch, no shape guessing)", async () => {
    const { alpha, beta, alphaSha, betaSha } = await primedPair();
    const payload = l3ExportL1Payload(await currentVector(), [
      { pair: [alpha, beta], heads: { [alpha]: alphaSha, [beta]: betaSha }, status: "clean" },
    ]);
    const mutated = { ...payload, contract: "0.2" };
    const response = await checks(mutated);
    expect(response.status).toBe(400);
    const body = await json<{ error: string }>(response);
    expect(body.error).toContain("contract");
    expect(body.error).toContain("0.1");
    expect(body.error).toContain("0.0");
  });

  it("typed rejections: legacy shapes inside a contract 0.1 envelope are 400", async () => {
    const { alpha, beta, alphaSha, betaSha } = await primedPair();
    const vector = await currentVector();
    const heads = { [alpha]: alphaSha, [beta]: betaSha };

    const expect400 = async (mutate: (payload: Record<string, unknown>) => unknown, fragment: string) => {
      const base = l3ExportL1Payload(vector, [
        { pair: [alpha, beta], heads, status: "clean", evidence: { tests_collected: 3, details: "ok" } },
      ]);
      const response = await checks(mutate(base) as Record<string, unknown>);
      expect(response.status).toBe(400);
      const body = await json<{ error: string }>(response);
      expect(body.error).toContain(fragment);
    };

    // string policy is the legacy adapter shape
    await expect400((p) => ({ ...p, policy: "merge-tree-v1" }), "policy");
    // string[] coverage is the legacy adapter shape
    await expect400((p) => ({ ...p, coverage: [`${alpha}|${beta}`] }), "coverage");
    // legacy free-form classifier is not a contract 0.1 kind
    await expect400(
      (p) => ({ ...p, results: [{ ...((p.results as Record<string, unknown>[])[0]), kind: "merge-conflict" }] }),
      "invalid radar kind",
    );
    // string evidence is the legacy adapter shape
    await expect400(
      (p) => ({ ...p, results: [{ ...((p.results as Record<string, unknown>[])[0]), evidence: "exit 0" }] }),
      "evidence",
    );
    // evidence object without any summary-ish field (summary/details/error/
    // reason — the L3 exporter fallback chain) is rejected
    await expect400(
      (p) => ({ ...p, results: [{ ...((p.results as Record<string, unknown>[])[0]), evidence: { exit_code: 0 } }] }),
      "summary",
    );
    // non-numeric per-pair coverage
    await expect400(
      (p) => ({
        ...p,
        results: [{ ...((p.results as Record<string, unknown>[])[0]), evidence: { summary: "ok", tests_collected: "3" } }],
      }),
      "tests_collected",
    );
    // per-pair heads must be present and match the gated vector
    await expect400(
      (p) => ({ ...p, results: [{ ...((p.results as Record<string, unknown>[])[0]), heads: { [alpha]: alphaSha } }] }),
      "heads",
    );
    await expect400(
      (p) => ({
        ...p,
        results: [{ ...((p.results as Record<string, unknown>[])[0]), heads: { [alpha]: alphaSha, [beta]: "f".repeat(40) } }],
      }),
      "heads",
    );

    // runner statuses stay restricted through the typed wire too
    const notChecked = await checks(
      l3ExportL1Payload(vector, [
        { pair: [alpha, beta], heads, status: "not_checked" },
      ]),
    );
    expect(notChecked.status).toBe(400);
    const bogus = await checks(
      l3ExportL1Payload(vector, [{ pair: [alpha, beta], heads, status: "bogus" }]),
    );
    expect(bogus.status).toBe(400);

    // missing agent in pair
    const ghost = await checks(
      l3ExportL1Payload(vector, [{ pair: [alpha, "ghost"], heads: { [alpha]: alphaSha, ghost: "g" }, status: "clean" }]),
    );
    expect(ghost.status).toBe(400);
  });

  it("a typed payload without evidence is accepted; nothing is stated, nothing recorded", async () => {
    const { alpha, beta, alphaSha, betaSha } = await primedPair();
    // The real L3 exporter ALWAYS emits evidence (summary+files); build the
    // no-evidence payload by hand to prove the wire's optional evidence.
    const base = l3ExportL1Payload(await currentVector(), [
      { pair: [alpha, beta], heads: { [alpha]: alphaSha, [beta]: betaSha }, status: "clean" },
    ]);
    const results = base.results as Record<string, unknown>[];
    delete results[0].evidence;
    const response = await checks(base);
    expect(response.status).toBe(200);
    const body = await json<ChecksResponse>(response);
    const view = pairFor(body.pairs, alpha, beta);
    expect(view.status).toBe("clean");
    expect(view.evidence).toBeUndefined();
    expect(view.coverage).toBeUndefined();
  });
});
