import { describe, expect, it } from "vitest";
import { ArtifactsRestClient } from "../src/artifacts/rest.js";
import { ArtifactsAuthScopeError, ArtifactsNotFoundError, classifyGitHttpError } from "../src/artifacts/errors.js";
import { mapRawCommit } from "../src/artifacts/map.js";
import {
  SPIKE_BASE_COMMIT,
  SPIKE_FORK,
  SPIKE_NAMESPACE,
  SPIKE_NAMESPACE_NOT_FOUND,
  SPIKE_PUSHED_COMMIT,
  SPIKE_REPO_CREATE,
  SPIKE_REPO_SINGLE_GET,
  SPIKE_REPOS_LIST,
  SPIKE_TOKEN_MINT,
} from "./fixtures/artifacts-spike.js";

/**
 * Offline tests for the bootstrap-side REST seam (PLAN-L1-REAL §1: thin REST
 * client ONLY — namespace/repo creation and fork have NO wrangler
 * subcommands). Every response body is a fixture from the sanitized real
 * transcript (artifacts-spike @ c75faa1); fetch is injected, nothing touches
 * the network and no credential exists here.
 */

const ACCOUNT = "test-account-id";
const API_TOKEN = "test-api-token-not-a-real-secret";
const BASE = "https://rest.test/client/v4";

type Route = {
  method: string;
  /** Suffix of the pathname after /accounts/<account>/artifacts. */
  path: string;
  status: number;
  body: unknown;
};

interface CallRecord {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

function fakeFetch(routes: Route[], calls: CallRecord[]) {
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ url, method, authorization: headers.get("authorization"), body: init?.body });
    const pathWithQuery = url.replace(`${BASE}/accounts/${ACCOUNT}/artifacts`, "");
    const path = pathWithQuery.split("?")[0];
    const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
    if (route === undefined) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: -1, message: `no fixture for ${method} ${path}` }] }), {
        status: 500,
      });
    }
    return new Response(JSON.stringify(route.body), { status: route.status });
  }) as typeof fetch;
  return impl;
}

function client(routes: Route[], calls: CallRecord[]) {
  return new ArtifactsRestClient({ accountId: ACCOUNT, apiToken: API_TOKEN, baseUrl: BASE, fetch: fakeFetch(routes, calls) });
}

const envelope = (result: unknown) => ({ result, success: true, errors: [], messages: [] });

describe("ArtifactsRestClient against spike fixtures (offline)", () => {
  it("ensureNamespace: GET 404/10200 → POST create (spike O1→O2), Bearer header, token never in URL", async () => {
    const calls: CallRecord[] = [];
    const rest = client(
      [
        { method: "GET", path: "/namespaces/agent-branches-dev", status: 404, body: SPIKE_NAMESPACE_NOT_FOUND },
        { method: "POST", path: "/namespaces", status: 201, body: envelope(SPIKE_NAMESPACE) },
      ],
      calls,
    );
    const ensured = await rest.ensureNamespace("agent-branches-dev");
    expect(ensured.created).toBe(true);
    expect(ensured.namespace.namespace).toBe("agent-branches-dev");
    expect(ensured.namespace.repo_count).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    for (const call of calls) {
      expect(call.authorization).toBe(`Bearer ${API_TOKEN}`);
      expect(call.url).not.toContain(API_TOKEN);
    }
  });

  it("ensureNamespace: existing namespace → created:false, no POST (spike O3)", async () => {
    const calls: CallRecord[] = [];
    const rest = client(
      [{ method: "GET", path: "/namespaces/agent-branches-dev", status: 200, body: envelope(SPIKE_NAMESPACE) }],
      calls,
    );
    const ensured = await rest.ensureNamespace("agent-branches-dev");
    expect(ensured.created).toBe(false);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("getNamespace returns null (not a throw) on 404 + code 10200 (spike O1)", async () => {
    const rest = client(
      [{ method: "GET", path: "/namespaces/absent", status: 404, body: SPIKE_NAMESPACE_NOT_FOUND }],
      [],
    );
    expect(await rest.getNamespace("absent")).toBeNull();
  });

  it("createRepo returns remote + opaque token verbatim (spike O4)", async () => {
    const rest = client(
      [
        {
          method: "POST",
          path: "/namespaces/agent-branches-dev/repos",
          status: 200,
          body: envelope(SPIKE_REPO_CREATE),
        },
      ],
      [],
    );
    const repo = await rest.createRepo("agent-branches-dev", "demo-canonical", {
      description: "agent-branches demo canonical base (spike)",
    });
    expect(repo.id).toBe("u7usp14xkllei2on");
    expect(repo.remote).toContain("/git/agent-branches-dev/demo-canonical.git");
    expect(repo.token).toMatch(/^art_v2_x_[0-9a-f]{40}\?expires=\d+$/);
  });

  it("fork returns the copied object count + token (spike O9); wrangler has no fork cmd", async () => {
    const calls: CallRecord[] = [];
    const rest = client(
      [
        {
          method: "POST",
          path: "/namespaces/agent-branches-dev/repos/demo-canonical/fork",
          status: 200,
          body: envelope(SPIKE_FORK),
        },
      ],
      calls,
    );
    const forked = await rest.fork("agent-branches-dev", "demo-canonical", "demo-agent-1", {
      default_branch_only: true, // F CONFIRMED: default-branch only is the only mode
    });
    expect(forked.objects).toBe(15);
    expect(forked.name).toBe("demo-agent-1");
    expect(calls[0].url).toContain("/repos/demo-canonical/fork");
  });

  it("LIST carries status:ready (spike O17) while single GET has no status (O111)", async () => {
    const rest = client(
      [
        { method: "GET", path: "/namespaces/agent-branches-dev/repos", status: 200, body: envelope([...SPIKE_REPOS_LIST]) },
        {
          method: "GET",
          path: "/namespaces/agent-branches-dev/repos/demo-agent-1",
          status: 200,
          body: envelope(SPIKE_REPO_SINGLE_GET),
        },
      ],
      [],
    );
    const listed = await rest.listRepos("agent-branches-dev", { limit: 50, sort: "name" });
    expect(listed).toHaveLength(3);
    for (const repo of listed) {
      expect(repo.status).toBe("ready");
      expect(repo.last_push_at).toBeNull(); // finding 3: always null — never a signal
    }
    const single = await rest.getRepo("agent-branches-dev", "demo-agent-1");
    expect(single).not.toBeNull();
    expect(single?.status).toBeUndefined(); // finding 2: single GET lacks status
  });

  it("mintToken preserves snake_case expires_at + opaque plaintext (spike O5)", async () => {
    const calls: CallRecord[] = [];
    const rest = client(
      [
        {
          method: "POST",
          path: "/namespaces/agent-branches-dev/repos/demo-canonical/tokens",
          status: 200,
          body: envelope(SPIKE_TOKEN_MINT),
        },
      ],
      calls,
    );
    const token = await rest.mintToken("agent-branches-dev", "demo-canonical", "write", 3600);
    expect(token.expires_at).toBe("2026-10-03T17:58:29.832Z"); // +1h exactly
    expect(token.scope).toBe("write");
    expect(token.plaintext).toMatch(/^art_v2_x_/); // opaque passthrough, no validation
    const body = JSON.parse(String(calls[0].body ?? "{}")) as { scope: string; ttl: number };
    expect(body).toEqual({ scope: "write", ttl: 3600 });
  });

  it("log returns RAW commits (hash + epoch-seconds) and mapRawCommit ports them (spike O13)", async () => {
    const calls: CallRecord[] = [];
    const rest = client(
      [
        {
          method: "GET",
          path: "/namespaces/agent-branches-dev/repos/demo-agent-1/log",
          status: 200,
          body: envelope([SPIKE_BASE_COMMIT]),
        },
      ],
      calls,
    );
    const raw = await rest.log("agent-branches-dev", "demo-agent-1", { ref: "main", limit: 1 });
    expect(raw[0].hash).toBe(SPIKE_BASE_COMMIT.hash);
    expect(typeof raw[0].committedAt).toBe("number");
    expect(calls[0].url).toContain("ref=main&limit=1");
    const port = mapRawCommit(raw[0]);
    expect(port.id).toBe(SPIKE_BASE_COMMIT.hash);
    expect(port.timestamp).toBe("2026-10-03T16:59:59.000Z");
    // The pushed commit (O16) maps the same way:
    expect(mapRawCommit({ ...SPIKE_PUSHED_COMMIT }).parents).toEqual([SPIKE_BASE_COMMIT.hash]);
  });

  it("maps a 404/10200 repo route failure to ArtifactsNotFoundError with serviceCode 10200", async () => {
    const rest = client(
      [
        {
          method: "GET",
          path: "/namespaces/agent-branches-dev/repos/absent/log",
          status: 404,
          body: SPIKE_NAMESPACE_NOT_FOUND,
        },
      ],
      [],
    );
    try {
      await rest.log("agent-branches-dev", "absent", { limit: 1 });
      expect.unreachable("expected ArtifactsNotFoundError");
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactsNotFoundError);
      expect((err as ArtifactsNotFoundError).serviceCode).toBe(10200);
      expect((err as ArtifactsNotFoundError).status).toBe(404);
    }
  });

  it("classifies a read-scope push rejection (HTTP 400, spike O27) as an auth/scope failure", () => {
    const err = classifyGitHttpError(400, "push");
    expect(err).toBeInstanceOf(ArtifactsAuthScopeError);
    expect(err.message).toContain("not 401/403");
  });
});
