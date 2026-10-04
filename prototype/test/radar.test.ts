import { describe, expect, it } from "vitest";
import { SilentRadar, StubRadar } from "../src/radar.js";

describe("radar result status contract (codex C-1305 #1)", () => {
  const heads = { "alpha-0001": "1".repeat(40), "beta-0002": "2".repeat(40) };
  const change = { agent: "alpha-0001", ref: "refs/heads/main", sha: heads["alpha-0001"], before: null };

  it("StubRadar returns not_checked for every sibling pair — never a conflict from differing heads", () => {
    const results = new StubRadar().onPush(change, heads, ["alpha-0001", "beta-0002"]);
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.pair).toEqual(["alpha-0001", "beta-0002"]);
    expect(result.heads).toEqual({ a: heads["alpha-0001"], b: heads["beta-0002"] });
    expect(result.status).toBe("not_checked");
    expect(result.kind).toBeUndefined();
    expect(result.evidence).toBeUndefined();
  });

  it("still reports not_checked when heads are identical", () => {
    const same = { "alpha-0001": heads["alpha-0001"], "beta-0002": heads["alpha-0001"] };
    const results = new StubRadar().onPush(change, same, ["alpha-0001", "beta-0002"]);
    expect(results[0].status).toBe("not_checked");
  });

  it("checks every sibling, skipping only the pushing agent", () => {
    const many = { a: "a".repeat(40), b: "b".repeat(40), c: "c".repeat(40), d: "d".repeat(40) };
    const results = new StubRadar().onPush(
      { agent: "a", ref: "refs/heads/main", sha: many.a, before: null },
      many,
      Object.keys(many),
    );
    expect(results.map((r) => r.pair[1])).toEqual(["b", "c", "d"]);
    for (const result of results) {
      expect(result.status).toBe("not_checked");
    }
  });

  it("SilentRadar returns no results", () => {
    expect(new SilentRadar().onPush(change, heads, ["alpha-0001", "beta-0002"])).toEqual([]);
  });
});
