/**
 * POST /checks wire adapters (codex C-1350, CONTRACT 0.1.1).
 *
 * Two accepted payload shapes, selected by the mandatory `contract` field:
 *
 * - **"0.1"** — the canonical typed shape produced by the L3 runner's
 *   `export_l1_payload` (branch proto/l3-radar): vector keyed by agentId,
 *   structured `policy`/`coverage` objects (recorded verbatim), and
 *   per-result `heads` keyed by agentId plus object evidence (`summary` —
 *   falling back to details/error/reason exactly like the L3 exporter —
 *   optional `files`, `test_output_tail`, `tests_collected`). `kind` is
 *   restricted to "textual" | "test" | null.
 * - **"0.0"** — the pre-0.1 legacy shape (string `policy`, string-array
 *   `coverage`, string per-result `evidence`, free-form `kind`), accepted
 *   ONLY when the payload declares it.
 *
 * A payload without (or with an unknown) `contract` is rejected: callers
 * must declare which wire they speak. Parser errors are caller-safe
 * messages the route maps to 400. Per-result heads VALUES are validated
 * against the vector only AFTER the coordinator's stale-vector gate, so a
 * stale submission still gets its 409 (test/wire.test.ts).
 */

export interface ChecksPolicySpec {
  merge: string;
  tests: { command: string[] | null; budget_s: number };
}

export interface ChecksCoverageCounts {
  pairs_checked: number;
  tests_collected: number;
}

/** Radar/runner conflict classifiers permitted on the typed 0.1 wire. */
const V01_KINDS = ["textual", "test"] as const;

/**
 * JSON-safe flat bag for verbatim typed evidence. Deliberately NOT
 * Record<string, unknown>: the workers typed-RPC stub mapping collapses a
 * method to `never` when a return-visible type carries an unknown-valued
 * index signature (found the hard way on PairStatusView). Diagnostic fields
 * are flat scalars/arrays (files, test_output_tail, exit_code, ...); the
 * runtime value stored is whatever JSON object the runner sent.
 */
export type EvidenceBag = Record<string, string | number | boolean | null | string[]>;

/** Normalized per-pair result, identical for both input contracts. */
export interface NormalizedCheckResult {
  pair: [string, string];
  status: string;
  kind?: string;
  /** Summary string recorded on warnings/radar log. */
  evidence?: string;
  /** Verbatim evidence object recorded on the pair view (0.1 only). */
  evidenceDetail?: EvidenceBag;
  /** Per-pair combined-test coverage (0.1: evidence.tests_collected). */
  testsCollected?: number;
  /** 0.1 per-result heads keyed by agentId; value-checked post stale gate. */
  heads?: Record<string, string>;
}

export interface NormalizedChecksPayload {
  vector: Record<string, string>;
  /** String used in warnings/resolution notes: 0.0 policy or 0.1 policy.merge. */
  policy: string;
  /** Verbatim policy: string (0.0) or object (0.1), recorded on the runner report. */
  policyVerbatim: string | ChecksPolicySpec;
  /** Verbatim coverage: string[] (0.0) or counts object (0.1). */
  coverageVerbatim?: string[] | ChecksCoverageCounts;
  results: NormalizedCheckResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseChecksPayload(body: Record<string, unknown>): NormalizedChecksPayload {
  if (body.contract !== "0.1" && body.contract !== "0.0") {
    throw new Error(
      `unsupported contract version: expected "0.1" (canonical typed shape) or "0.0" (legacy adapter), got ${
        body.contract === undefined ? "no contract field" : JSON.stringify(body.contract)
      }`,
    );
  }
  if (!isRecord(body.vector) || !Object.values(body.vector).every((sha) => typeof sha === "string")) {
    throw new Error("vector {agent: sha} is required");
  }
  if (!Array.isArray(body.results)) {
    throw new Error("results must be an array");
  }
  return body.contract === "0.1" ? parseV01(body) : parseV00(body);
}

/** Legacy adapter: pass the pre-0.1 string shape through; the Coordinator
 * keeps validating pair shape, known agents and the status enum. */
function parseV00(body: Record<string, unknown>): NormalizedChecksPayload {
  const results = body.results as Record<string, unknown>[];
  const policy = stringOrUndefined(body.policy) ?? "unknown-policy";
  return {
    vector: body.vector as Record<string, string>,
    policy,
    policyVerbatim: policy,
    coverageVerbatim: Array.isArray(body.coverage) ? (body.coverage as string[]) : undefined,
    results: results.map((result) => ({
      pair: result.pair as [string, string],
      status: result.status as string,
      kind: stringOrUndefined(result.kind),
      evidence: stringOrUndefined(result.evidence),
    })),
  };
}

function parseV01(body: Record<string, unknown>): NormalizedChecksPayload {
  const vector = body.vector as Record<string, string>;
  const policySpec = parseV01Policy(body.policy);
  const results = (body.results as Record<string, unknown>[]).map((result) => parseV01Result(result));
  return {
    vector,
    policy: policySpec.merge,
    policyVerbatim: policySpec,
    coverageVerbatim: parseV01Coverage(body.coverage),
    results,
  };
}

function parseV01Policy(raw: unknown): ChecksPolicySpec {
  if (raw === undefined) {
    return { merge: "unknown-policy", tests: { command: null, budget_s: 15 } };
  }
  if (!isRecord(raw)) {
    throw new Error('policy must be an object {merge, tests: {command, budget_s}} for contract "0.1" (string policy is the contract "0.0" adapter shape)');
  }
  const merge = raw.merge === undefined ? "unknown-policy" : raw.merge;
  if (typeof merge !== "string") {
    throw new Error('policy.merge must be a string for contract "0.1"');
  }
  let command: string[] | null = null;
  let budget_s = 15;
  if (raw.tests !== undefined) {
    if (!isRecord(raw.tests)) {
      throw new Error('policy.tests must be an object {command, budget_s} for contract "0.1"');
    }
    if (typeof raw.tests.command === "string") {
      command = raw.tests.command.trim().length > 0 ? raw.tests.command.trim().split(/\s+/) : null;
    } else if (Array.isArray(raw.tests.command)) {
      if (!raw.tests.command.every((part) => typeof part === "string")) {
        throw new Error('policy.tests.command must be a string or an array of strings for contract "0.1"');
      }
      command = raw.tests.command as string[];
    } else if (raw.tests.command !== undefined && raw.tests.command !== null) {
      throw new Error('policy.tests.command must be a string or an array of strings for contract "0.1"');
    }
    if (raw.tests.budget_s !== undefined) {
      if (typeof raw.tests.budget_s !== "number" || !Number.isFinite(raw.tests.budget_s) || raw.tests.budget_s < 0) {
        throw new Error('policy.tests.budget_s must be a non-negative number for contract "0.1"');
      }
      budget_s = raw.tests.budget_s;
    }
  }
  return { merge, tests: { command, budget_s } };
}

function parseV01Coverage(raw: unknown): ChecksCoverageCounts | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw) || !isCount(raw.pairs_checked) || !isCount(raw.tests_collected)) {
    throw new Error('coverage must be a {pairs_checked, tests_collected} object of non-negative integers for contract "0.1" (a string[] coverage is the contract "0.0" adapter shape)');
  }
  return { pairs_checked: raw.pairs_checked, tests_collected: raw.tests_collected };
}

function parseV01Result(result: Record<string, unknown>): NormalizedCheckResult {
  if (!Array.isArray(result.pair) || result.pair.length !== 2 || !result.pair.every((id) => typeof id === "string")) {
    throw new Error("check result requires pair [a, b]");
  }
  const pair = result.pair as [string, string];
  // Per-result heads are REQUIRED on the typed wire and must cover every
  // pair agent; their VALUES are checked against the vector by the
  // coordinator after the stale gate so stale submissions stay 409.
  if (!isRecord(result.heads)) {
    throw new Error('result heads must be an object {agentId: sha} covering the pair for contract "0.1"');
  }
  const heads: Record<string, string> = {};
  for (const agent of pair) {
    if (typeof result.heads[agent] !== "string") {
      throw new Error(`result heads must map every pair agent to its sha (missing ${agent}) for contract "0.1"`);
    }
    heads[agent] = result.heads[agent] as string;
  }
  if (typeof result.status !== "string") {
    throw new Error("check result requires a string status");
  }
  let kind: string | undefined;
  if (result.kind !== undefined && result.kind !== null) {
    if (typeof result.kind !== "string" || !(V01_KINDS as readonly string[]).includes(result.kind)) {
      throw new Error(`invalid radar kind: ${JSON.stringify(result.kind)} for contract "0.1" (textual|test|null)`);
    }
    kind = result.kind;
  }
  let evidence: string | undefined;
  let evidenceDetail: EvidenceBag | undefined;
  let testsCollected: number | undefined;
  if (result.evidence !== undefined && result.evidence !== null) {
    if (!isRecord(result.evidence)) {
      throw new Error(
        'result evidence must be an object for contract "0.1" — the legacy string evidence belongs to contract "0.0"',
      );
    }
    // Same fallback chain as the L3 exporter: summary, details, error, reason.
    const raw = result.evidence;
    const summary =
      stringOrUndefined(raw.summary) ?? stringOrUndefined(raw.details) ?? stringOrUndefined(raw.error) ?? stringOrUndefined(raw.reason);
    if (summary === undefined) {
      throw new Error('evidence requires a string summary (summary, details, error or reason) for contract "0.1"');
    }
    evidence = summary;
    evidenceDetail = raw as EvidenceBag;
    if (raw.tests_collected !== undefined && raw.tests_collected !== null) {
      const collected = raw.tests_collected;
      if (typeof collected !== "number" || !Number.isFinite(collected) || collected < 0) {
        throw new Error('evidence.tests_collected must be a non-negative number for contract "0.1"');
      }
      testsCollected = collected;
    }
    // Further diagnostic fields (files, test_output_tail, exit_code, ...) are
    // preserved verbatim on evidenceDetail and served on the pair view.
  }
  return { pair, status: result.status, kind, evidence, evidenceDetail, testsCollected, heads };
}
