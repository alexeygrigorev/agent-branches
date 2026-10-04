import { expect, it, describe } from "vitest";
import {
  RealArtifacts,
  type ArtifactsNamespaceBinding,
  type ArtifactsRepoCapability,
  type RawRepoListEntry,
} from "../src/artifacts/real.js";
import {
  ArtifactsAuthScopeError,
  ArtifactsForkNotReadyError,
  ArtifactsNotFoundError,
  classifyGitHttpError,
} from "../src/artifacts/errors.js";
import { epochSecondsToIso, mapRawCommit } from "../src/artifacts/map.js";
import {
  SPIKE_BASE_COMMIT,
  SPIKE_FAKE_REPO_TOKEN,
  SPIKE_PUSHED_COMMIT,
} from "./fixtures/artifacts-spike.js";

/**
 * RealArtifacts must match REALITY (artifacts-spike @ c75faa1). The fake
 * binding below returns the REAL shapes: commits carry hash/treeHash and
 * EPOCH-SECONDS authoredAt/committedAt (finding B) — NOT id/ISO timestamp —
 * and tokens are opaque art_v2_x_… strings (finding 1). Every mapping test
 * here fails against the pre-spike adapter (which read `.id` and assumed
 * documented shapes).
 */

const TIP = SPIKE_BASE_COMMIT.hash; // b4346112…, the real base commit
const PUSHED = SPIKE_PUSHED_COMMIT.hash; // c809475…, the real pushed commit

interface FakeState {
  forkCalls: { target: string; opts: unknown }[];
  logCalls: number;
  listCalls: number;
  listResponses: RawRepoListEntry[][];
  getNames: string[];
  infoCalls: number;
  readCommitResult: ReturnType<typeof structuredClone> | null;
  createTokenResult: { plaintext: string; expiresAt: string; scope: "read" | "write" };
  failWith?: unknown;
}

const TIP_LOG_PAGE = (): [typeof SPIKE_BASE_COMMIT] => [
  { ...SPIKE_BASE_COMMIT, author: { ...SPIKE_BASE_COMMIT.author }, committer: { ...SPIKE_BASE_COMMIT.committer } },
];

function fakeCapability(state: FakeState): ArtifactsRepoCapability {
  return {
    info: async () => {
      state.infoCalls += 1;
      return { name: "demo-canonical", defaultBranch: "main", description: null, readOnly: false };
    },
    createToken: async (scope) => ({ ...state.createTokenResult, scope: scope ?? state.createTokenResult.scope }),
    listTokens: async () => ({ total: 0, tokens: [] }),
    revokeToken: async () => true,
    fork: async (target, opts) => {
      state.forkCalls.push({ target, opts: opts ?? null });
      if (state.failWith !== undefined) {
        throw state.failWith;
      }
      return {
        name: target,
        remote: `https://<account_id>.artifacts.cloudflare.net/git/agent-branches-dev/${target}.git`,
        defaultBranch: "main",
        token: SPIKE_FAKE_REPO_TOKEN,
      };
    },
    log: async () => {
      if (state.failWith !== undefined) {
        throw state.failWith;
      }
      state.logCalls += 1;
      return TIP_LOG_PAGE();
    },
    readCommit: async () => (state.readCommitResult === null ? null : { ...SPIKE_BASE_COMMIT }),
    readTree: async () => null,
    readBlob: async () => null,
    readFile: async () => null,
    [Symbol.dispose]: () => {},
  };
}

function fakeBinding(state: FakeState): ArtifactsNamespaceBinding {
  const capability = fakeCapability(state);
  return {
    create: async () => {
      if (state.failWith !== undefined) {
        throw state.failWith;
      }
      return {
        name: "demo-canonical",
        remote: "https://<account_id>.artifacts.cloudflare.net/git/agent-branches-dev/demo-canonical.git",
        defaultBranch: "main",
        token: SPIKE_FAKE_REPO_TOKEN,
      };
    },
    get: async (name) => {
      if (state.failWith !== undefined) {
        throw state.failWith;
      }
      state.getNames.push(name);
      return capability;
    },
    list: async () => {
      if (state.failWith !== undefined) {
        throw state.failWith;
      }
      state.listCalls += 1;
      const page = state.listResponses.shift() ?? state.listResponses[state.listResponses.length - 1] ?? [];
      return { repos: page.map((entry) => ({ ...entry })) };
    },
    import: async () => {
      throw new Error("not exercised");
    },
    delete: async () => true,
  };
}

const REAL_TOKEN_RESULT = {
  // Real format (finding 1): art_v2_x_<40hex>?expires=<unix>. The old
  // documented art_v1_ prefix would be WRONG here.
  plaintext: SPIKE_FAKE_REPO_TOKEN,
  expiresAt: "2026-10-03T17:58:29.832Z",
  scope: "write" as const,
};

const instantReadiness = {
  readiness: { maxAttempts: 5, delayMs: 0 },
  sleep: async () => {},
};

describe("RealArtifacts matches the REAL commit shape (finding B, spike O13/O16)", () => {
  it("headCommit reads .hash — NOT .id (fails on the old adapter)", async () => {
    const port = new RealArtifacts(fakeBinding({ ...freshState() }), instantReadiness);
    // Old code: commits[0]?.id — undefined against the real shape → null.
    expect(await port.headCommit("demo-agent-1")).toBe(TIP);
  });

  it("log maps hash→id and epoch-seconds committedAt→ISO timestamp", async () => {
    const state = freshState();
    const port = new RealArtifacts(fakeBinding(state), instantReadiness);
    const commits = await port.log("demo-canonical", { limit: 1 });
    expect(commits).toHaveLength(1);
    expect(commits[0].id).toBe(TIP);
    expect(commits[0].timestamp).toBe("2026-10-03T16:59:59.000Z"); // 1791046799
    expect(commits[0].message).toBe(SPIKE_BASE_COMMIT.message);
    expect(commits[0].parents).toEqual([]);
    expect(commits[0].author).toEqual({ name: "zc-artifacts-1", email: "zc-artifacts-1@aplexer.local" });
    // The raw epoch fields must never leak through as the port timestamp:
    expect(commits[0].timestamp).not.toBe(String(SPIKE_BASE_COMMIT.committedAt));
  });

  it("epochSecondsToIso converts the observed spike instants exactly", () => {
    expect(epochSecondsToIso(1791046799)).toBe("2026-10-03T16:59:59.000Z"); // O13
    expect(epochSecondsToIso(1791046878)).toBe("2026-10-03T17:01:18.000Z"); // O16
  });

  it("mapRawCommit refuses raw commits without hash or epoch committedAt", () => {
    expect(() => mapRawCommit({ ...SPIKE_BASE_COMMIT, hash: undefined as unknown as string })).toThrow(/hash/);
    expect(() => mapRawCommit({ ...SPIKE_BASE_COMMIT, committedAt: undefined as unknown as number })).toThrow(
      /committedAt/,
    );
  });

  it("hasCommit is true when readCommit returns a real raw commit", async () => {
    const state = freshState();
    state.readCommitResult = { ...SPIKE_PUSHED_COMMIT };
    const port = new RealArtifacts(fakeBinding(state), instantReadiness);
    expect(await port.hasCommit("demo-agent-1", PUSHED)).toBe(true);
  });
});

describe("tokens are opaque (finding 1: real format art_v2_x_…, docs say art_v1_)", () => {
  it("mintToken passes the real art_v2_x_ token through with NO prefix validation", async () => {
    const port = new RealArtifacts(fakeBinding({ ...freshState() }), instantReadiness);
    const result = await port.mintToken("demo-canonical", "write", 3600);
    // Any art_v1_ prefix check would have rejected/rewritten this:
    expect(result.plaintext.startsWith("art_v2_x_")).toBe(true);
    expect(result.plaintext).toBe(SPIKE_FAKE_REPO_TOKEN); // verbatim, incl. ?expires=
    expect(result.scope).toBe("write");
  });

  it("createRepo/fork results carry the opaque token verbatim", async () => {
    const port = new RealArtifacts(fakeBinding({ ...freshState() }), instantReadiness);
    const created = await port.createRepo("demo-canonical");
    expect(created.token).toBe(SPIKE_FAKE_REPO_TOKEN);
    const forked = await port.fork("demo-canonical", "demo-agent-9");
    expect(forked.token).toBe(SPIKE_FAKE_REPO_TOKEN);
  });
});

describe("fork readiness is polled from the LIST status (findings 2+F)", () => {
  it("waits for status:'ready' on LIST, never single-GET status or last_push_at", async () => {
    const state = freshState();
    state.listResponses = [
      [{ name: "demo-agent-9", status: "forking" }],
      [{ name: "demo-agent-9", status: "forking" }, { name: "demo-canonical", status: "ready" }],
      [{ name: "demo-agent-9", status: "ready" }],
    ];
    const port = new RealArtifacts(fakeBinding(state), instantReadiness);
    const result = await port.fork("demo-canonical", "demo-agent-9", {
      description: "agent fork",
      defaultBranchOnly: true,
      baseSha: "a".repeat(40), // non-tip base: F says the fork starts at the tip anyway
    });
    expect(result.name).toBe("demo-agent-9");
    expect(result.baseSha).toBe(TIP); // realized base read AFTER ready
    expect(state.listCalls).toBe(3); // readiness via LIST only — old adapter polled 0 times
    // status has no field on single GET → info() must never be consulted:
    expect(state.infoCalls).toBe(0);
    expect(state.getNames).toEqual(["demo-canonical", "demo-agent-9"]); // fork + realized-head reads
    // list entries carried no last_push_at decisions; readiness came from status.
  });

  it("throws ArtifactsForkNotReadyError (bounded) when LIST never shows ready", async () => {
    const state = freshState();
    state.listResponses = [[{ name: "demo-agent-9", status: "forking" }]];
    const port = new RealArtifacts(fakeBinding(state), {
      readiness: { maxAttempts: 3, delayMs: 0 },
      sleep: async () => {},
    });
    await expect(port.fork("demo-canonical", "demo-agent-9")).rejects.toBeInstanceOf(ArtifactsForkNotReadyError);
    expect(state.listCalls).toBe(3);
  });

  it("listRepos maps a missing/unknown status to the conservative NOT-ready state", async () => {
    const state = freshState();
    state.listResponses = [[{ name: "fresh-fork" }]]; // single-GET-style entry, no status
    const port = new RealArtifacts(fakeBinding(state), instantReadiness);
    expect(await port.listRepos()).toEqual([{ name: "fresh-fork", status: "importing" }]);
  });
});

describe("typed errors from real service behavior (findings 4/5)", () => {
  it("normalizes a 404 + code 10200 throw into ArtifactsNotFoundError", async () => {
    const state = freshState();
    state.failWith = Object.assign(new Error("Namespace not found"), { status: 404, code: 10200 });
    const port = new RealArtifacts(fakeBinding(state), instantReadiness);
    await expect(port.log("missing-ns", { limit: 1 })).rejects.toBeInstanceOf(ArtifactsNotFoundError);
  });

  it("classifyGitHttpError maps a read-scope push rejection (HTTP 400) to ArtifactsAuthScopeError", () => {
    // Spike O27: the real service rejects a read-scope push with HTTP 400,
    // NOT 401/403 — a 401/403-only mapping would misclassify it.
    const err = classifyGitHttpError(400, "push");
    expect(err).toBeInstanceOf(ArtifactsAuthScopeError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("400");
  });

  it("classifyGitHttpError maps 404 → NotFound and 401/403 → AuthScope", () => {
    expect(classifyGitHttpError(404, "fetch")).toBeInstanceOf(ArtifactsNotFoundError);
    expect(classifyGitHttpError(401, "fetch")).toBeInstanceOf(ArtifactsAuthScopeError);
    expect(classifyGitHttpError(403, "fetch")).toBeInstanceOf(ArtifactsAuthScopeError);
  });

  it("leaves unrecognized binding errors untouched (binding shape UNVERIFIED, D)", async () => {
    const state = freshState();
    state.failWith = new RangeError("some unrelated internal error");
    const port = new RealArtifacts(fakeBinding(state), instantReadiness);
    await expect(port.headCommit("demo-canonical")).rejects.toBeInstanceOf(RangeError);
  });
});

function freshState(): FakeState {
  return {
    forkCalls: [],
    logCalls: 0,
    listCalls: 0,
    listResponses: [
      [
        { name: "demo-canonical", status: "ready" },
        { name: "demo-agent-9", status: "ready" },
      ],
    ],
    getNames: [],
    infoCalls: 0,
    readCommitResult: null,
    createTokenResult: { ...REAL_TOKEN_RESULT },
  };
}
