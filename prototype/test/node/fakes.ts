/**
 * Offline fakes for the node --test suite (facade extraction, 2026-10-03):
 * an in-memory GitHost, a deterministic clock and a small services builder.
 * No workerd, no network, no real git — the POINT of this suite is proving
 * the core runs against the provider-neutral ports alone.
 */

import { StubRadar } from "../../src/radar.js";
import { ok } from "node:assert";
import { CoordinatorCore } from "../../src/core/coordinator.js";
import type { Clock, IdGenerator } from "../../src/ports/clock.js";
import type {
  ArtifactsCreateRepoResult,
  ArtifactsTokenResult,
  CommitMetadata,
  CreateRepoOptions,
  ForkOptions,
  ForkResult,
  GitHost,
  LogOptions,
  RepoName,
  RepoSummary,
  TokenScope,
  UnprocessedPush,
} from "../../src/ports/githost.js";
import { ArtifactsPushEvents, JsonPushEvents } from "../../src/ports/push-events.js";
import { MemoryCoordinationStore } from "../../src/local/store.js";
import type { RouterServices } from "../../src/core/router.js";

function sha(counter: number): string {
  return counter.toString(16).padStart(40, "0");
}

interface FakeRepo {
  commits: CommitMetadata[];
  tokens: ArtifactsTokenResult[];
}

export class FakeGitHost implements GitHost {
  private readonly repos = new Map<string, FakeRepo>();
  private counter = 0;
  unprocessed: UnprocessedPush[] = [];

  private nextCommit(message: string, parents: string[]): CommitMetadata {
    this.counter += 1;
    return {
      id: sha(this.counter),
      message,
      timestamp: `2026-10-03T12:00:${String(this.counter).padStart(2, "0")}.000Z`,
      parents,
    };
  }

  private repo(name: RepoName): FakeRepo {
    const existing = this.repos.get(name);
    if (!existing) {
      throw new Error(`repo not found: ${name}`);
    }
    return existing;
  }

  async createRepo(name: RepoName, opts?: CreateRepoOptions): Promise<ArtifactsCreateRepoResult> {
    if (this.repos.has(name)) {
      throw new Error(`repo already exists: ${name}`);
    }
    const seed = this.nextCommit(opts?.setDefaultBranch ?? "main", []);
    this.repos.set(name, {
      commits: [seed],
      tokens: [{ plaintext: `initial-${name}`, scope: "write", expiresAt: "2026-12-31T00:00:00.000Z" }],
    });
    return { name, remote: `file:///tmp/fake-git/${name}.git`, defaultBranch: opts?.setDefaultBranch ?? "main", token: `initial-${name}` };
  }

  async fork(source: RepoName, target: RepoName, opts?: ForkOptions): Promise<ForkResult> {
    const origin = this.repo(source);
    if (this.repos.has(target)) {
      throw new Error(`repo already exists: ${target}`);
    }
    let copied = [...origin.commits];
    if (opts?.baseSha) {
      const index = copied.findIndex((commit) => commit.id === opts.baseSha);
      if (index === -1) {
        throw new Error(`commit ${opts.baseSha} not found in ${source}`);
      }
      copied = copied.slice(0, index + 1);
    }
    this.repos.set(target, { commits: copied, tokens: [] });
    return {
      name: target,
      remote: `file:///tmp/fake-git/${target}.git`,
      defaultBranch: "main",
      token: `fork-token-${target}`,
    };
  }

  async mintToken(repo: RepoName, scope: TokenScope = "write", ttlSeconds = 3600): Promise<ArtifactsTokenResult> {
    this.counter += 1;
    const token: ArtifactsTokenResult = {
      plaintext: `tok-${this.counter.toString(16).padStart(8, "0")}`,
      // Relative to REAL now: a fixed base silently expires every fake
      // token once wall-clock passes it (observed 2026-10-03 evening), and
      // credentialAgent's expiry gate would then deny rig tokens everywhere.
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      scope,
    };
    this.repo(repo).tokens.push(token);
    return token;
  }

  async log(repo: RepoName, opts?: LogOptions): Promise<CommitMetadata[]> {
    const commits = [...this.repo(repo).commits].reverse();
    const offset = opts?.offset ?? 0;
    return commits.slice(offset, offset + (opts?.limit ?? 50));
  }

  async headCommit(repo: RepoName): Promise<string | null> {
    const commits = this.repo(repo).commits;
    return commits.length > 0 ? commits[commits.length - 1].id : null;
  }

  async hasCommit(repo: RepoName, shaValue: string): Promise<boolean> {
    return this.repo(repo).commits.some((commit) => commit.id === shaValue);
  }

  async listRepos(limit = 100): Promise<RepoSummary[]> {
    return [...this.repos.keys()].slice(0, limit).map((name) => ({ name, status: "ready" as const }));
  }

  async deleteRepo(name: RepoName): Promise<boolean> {
    return this.repos.delete(name);
  }

  async unprocessedPushes(): Promise<UnprocessedPush[]> {
    return [...this.unprocessed];
  }

  /** Test helper: append a commit as an agent's `git push` would. */
  commit(repo: RepoName, message: string): string {
    const target = this.repo(repo);
    const commit = this.nextCommit(message, target.commits.length ? [target.commits[target.commits.length - 1].id] : []);
    target.commits.push(commit);
    return commit.id;
  }
}

/** Deterministic clock: each iso() call advances one second. */
export function fakeClock(): Clock & { calls: number } {
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    iso: () => {
      calls += 1;
      return new Date(Date.parse("2026-10-03T12:00:00.000Z") + calls * 1000).toISOString();
    },
  };
}

export const fixedIds: IdGenerator = { suffix: () => "cafe1234" };

export interface TestRig {
  services: RouterServices;
  git: FakeGitHost;
  core: CoordinatorCore;
  store: MemoryCoordinationStore;
  clock: ReturnType<typeof fakeClock>;
}

/** Core + router services over the in-memory store and fake GitHost. */
export function makeRig(tokens: RouterServices["tokens"] = { admin: "admin-t", runner: "runner-t", sidecar: "sidecar-t" }): TestRig {
  const git = new FakeGitHost();
  const clock = fakeClock();
  const store = new MemoryCoordinationStore();
  const core = new CoordinatorCore({
    store,
    git,
    radar: new StubRadar(),
    clock,
    ids: fixedIds,
  });
  return {
    services: {
      coordinator: core,
      tokens,
      pushes: new JsonPushEvents("direct"),
      artifactsEvents: new ArtifactsPushEvents(),
    },
    git,
    core,
    store,
    clock,
  };
}

/** Convenience: authenticated JSON request against the neutral router. */
export function neutralRequest(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): import("../../src/core/router.js").HttpRequest {
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return {
    method,
    path,
    header: (name) => headers[name.toLowerCase()] ?? null,
    json: async () => {
      if (body === undefined) {
        throw new Error("no body");
      }
      return body;
    },
  };
}

/**
 * Assert a promise rejects with an Error whose message matches `pattern`;
 * resolves with the message otherwise-failing tests can inspect.
 */
export async function rejectionMessage(promise: Promise<unknown>, pattern: RegExp): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    ok(
      pattern.test(message),
      `expected rejection matching ${pattern}, got: ${message}`,
    );
    return message;
  }
  throw new Error(`expected rejection matching ${pattern}, but the promise resolved`);
}
