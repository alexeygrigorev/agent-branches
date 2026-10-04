import { describe, expect, it } from "vitest";
import { parseChecksPayload } from "../src/checks-wire.js";

/**
 * Pure unit tests for the POST /checks wire adapters (codex C-1350): the
 * canonical v0.1 typed shape (L3 export_l1_payload) and the explicit-0.0
 * legacy adapter. Route-level behavior is covered in checks.test.ts and
 * wire.test.ts.
 */
const SHA_A = "1".repeat(40);
const SHA_B = "2".repeat(40);

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: "0.1",
    vector: { "a-0001": SHA_A, "b-0002": SHA_B },
    policy: { merge: "git-merge-tree", tests: { command: "pytest -q", budget_s: 15 } },
    coverage: { pairs_checked: 1, tests_collected: 2 },
    results: [
      {
        pair: ["a-0001", "b-0002"],
        heads: { "a-0001": SHA_A, "b-0002": SHA_B },
        status: "clean",
        kind: null,
        evidence: { summary: "ok", files: ["x.ts"], test_output_tail: "2 passed", tests_collected: 2 },
      },
    ],
    ...overrides,
  };
}

describe("checks wire adapters (C-1350)", () => {
  it("normalizes the canonical v0.1 shape", () => {
    const parsed = parseChecksPayload(payload());
    expect(parsed.policy).toBe("git-merge-tree");
    expect(parsed.policyVerbatim).toEqual({
      merge: "git-merge-tree",
      tests: { command: ["pytest", "-q"], budget_s: 15 },
    });
    expect(parsed.coverageVerbatim).toEqual({ pairs_checked: 1, tests_collected: 2 });
    expect(parsed.results[0]).toEqual({
      pair: ["a-0001", "b-0002"],
      status: "clean",
      kind: undefined,
      evidence: "ok",
      evidenceDetail: { summary: "ok", files: ["x.ts"], test_output_tail: "2 passed", tests_collected: 2 },
      testsCollected: 2,
      heads: { "a-0001": SHA_A, "b-0002": SHA_B },
    });
  });

  it("falls back through the L3 summary chain (details/error/reason) and keeps 0 coverage", () => {
    const parsed = parseChecksPayload(
      payload({
        results: [
          {
            pair: ["a-0001", "b-0002"],
            heads: { "a-0001": SHA_A, "b-0002": SHA_B },
            status: "conflict",
            kind: "textual",
            evidence: { details: "Merge conflict in app.py" },
          },
        ],
      }),
    );
    expect(parsed.results[0]?.evidence).toBe("Merge conflict in app.py");
    expect(parsed.results[0]?.testsCollected).toBeUndefined();
  });

  it("accepts a result without evidence (nothing stated, nothing recorded)", () => {
    const parsed = parseChecksPayload(
      payload({
        results: [{ pair: ["a-0001", "b-0002"], heads: { "a-0001": SHA_A, "b-0002": SHA_B }, status: "clean" }],
      }),
    );
    expect(parsed.results[0]?.evidence).toBeUndefined();
    expect(parsed.results[0]?.evidenceDetail).toBeUndefined();
    expect(parsed.results[0]?.testsCollected).toBeUndefined();
  });

  it("keeps the 0.0 legacy shape verbatim (string policy/evidence, coverage list, free kind)", () => {
    const parsed = parseChecksPayload(
      payload({
        contract: "0.0",
        policy: "merge-tree-v1",
        coverage: ["a-0001|b-0002"],
        results: [{ pair: ["a-0001", "b-0002"], status: "conflict", kind: "merge-conflict", evidence: "exit 1" }],
      }),
    );
    expect(parsed.policy).toBe("merge-tree-v1");
    expect(parsed.policyVerbatim).toBe("merge-tree-v1");
    expect(parsed.coverageVerbatim).toEqual(["a-0001|b-0002"]);
    expect(parsed.results[0]).toEqual({
      pair: ["a-0001", "b-0002"],
      status: "conflict",
      kind: "merge-conflict",
      evidence: "exit 1",
      evidenceDetail: undefined,
      testsCollected: undefined,
      heads: undefined,
    });
  });

  it("rejects a missing or unknown contract field", () => {
    const { contract: _dropped, ...noContract } = payload();
    expect(() => parseChecksPayload(noContract)).toThrow(/unsupported contract version/);
    expect(() => parseChecksPayload(payload({ contract: "0.2" }))).toThrow(/unsupported contract version/);
  });

  it("rejects non-string vector values and non-array results", () => {
    expect(() => parseChecksPayload(payload({ vector: { "a-0001": 12 } }))).toThrow(/vector/);
    expect(() => parseChecksPayload(payload({ results: {} }))).toThrow(/results/);
  });

  it("requires per-result heads covering the pair (values checked later, after the 409 gate)", () => {
    expect(() =>
      parseChecksPayload(
        payload({ results: [{ pair: ["a-0001", "b-0002"], status: "clean" }] }),
      ),
    ).toThrow(/heads/);
    expect(() =>
      parseChecksPayload(
        payload({ results: [{ pair: ["a-0001", "b-0002"], heads: { "a-0001": SHA_A }, status: "clean" }] }),
      ),
    ).toThrow(/heads/);
    // A value that disagrees with the vector parses fine — the coordinator
    // rejects it after the stale gate (see wire.test.ts).
    const parsed = parseChecksPayload(
      payload({
        results: [{ pair: ["a-0001", "b-0002"], heads: { "a-0001": "9".repeat(40), "b-0002": SHA_B }, status: "clean" }],
      }),
    );
    expect(parsed.results[0]?.heads?.["a-0001"]).toBe("9".repeat(40));
  });

  it("rejects legacy shapes and malformed fields under the 0.1 envelope", () => {
    expect(() =>
      parseChecksPayload(
        payload({
          results: [{ pair: ["a-0001", "b-0002"], heads: { "a-0001": SHA_A, "b-0002": SHA_B }, status: "clean", evidence: "exit 0" }],
        }),
      ),
    ).toThrow(/evidence/);
    expect(() =>
      parseChecksPayload(
        payload({ results: [{ pair: ["a-0001", "b-0002"], heads: { "a-0001": SHA_A, "b-0002": SHA_B }, status: "clean", kind: "merge-conflict" }] }),
      ),
    ).toThrow(/invalid radar kind/);
    expect(() => parseChecksPayload(payload({ policy: "merge-tree-v1" }))).toThrow(/policy/);
    expect(() => parseChecksPayload(payload({ policy: { merge: 5 } }))).toThrow(/policy/);
    expect(() => parseChecksPayload(payload({ coverage: ["a-0001|b-0002"] }))).toThrow(/coverage/);
    expect(() =>
      parseChecksPayload(
        payload({
          results: [
            { pair: ["a-0001", "b-0002"], heads: { "a-0001": SHA_A, "b-0002": SHA_B }, status: "clean", evidence: { exit_code: 0 } },
          ],
        }),
      ),
    ).toThrow(/summary/);
    expect(() =>
      parseChecksPayload(
        payload({
          results: [
            {
              pair: ["a-0001", "b-0002"],
              heads: { "a-0001": SHA_A, "b-0002": SHA_B },
              status: "clean",
              evidence: { summary: "ok", tests_collected: "3" },
            },
          ],
        }),
      ),
    ).toThrow(/tests_collected/);
  });
});
