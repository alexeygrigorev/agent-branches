import { describe, expect, it } from "vitest";
import type { ArtifactsPushedEvent } from "../src/types.js";
import { parseArtifactsPushedEvent } from "../src/types.js";

describe("push event envelope", () => {
  const event: ArtifactsPushedEvent = {
    type: "cf.artifacts.repo.pushed",
    source: { type: "artifacts.repo", namespace: "ns", repoName: "some-fork" },
    payload: {
      ref: "refs/heads/main",
      before: "b".repeat(40),
      after: "a".repeat(40),
      commits: [
        {
          id: "a".repeat(40),
          message: "wip",
          messageTruncated: false,
          timestamp: "2026-10-03T10:00:00.000Z",
          parents: ["b".repeat(40)],
        },
      ],
      totalCommitsCount: 1,
      commitsTruncated: false,
    },
    metadata: {
      accountId: "acct",
      eventSubscriptionId: "sub",
      eventSchemaVersion: 1,
      eventTimestamp: "2026-10-03T10:00:00.132Z",
    },
  };

  it("parses a documented cf.artifacts.repo.pushed envelope", () => {
    const parsed = parseArtifactsPushedEvent(event);
    expect(parsed.payload.after).toBe("a".repeat(40));
    expect(parsed.source.repoName).toBe("some-fork");
  });

  it("rejects other event types and malformed payloads", () => {
    expect(() => parseArtifactsPushedEvent({ type: "cf.artifacts.repo.cloned" })).toThrow("unsupported event type");
    expect(() => parseArtifactsPushedEvent({ type: "cf.artifacts.repo.pushed", payload: {} })).toThrow();
    expect(() => parseArtifactsPushedEvent(null)).toThrow();
  });
});
