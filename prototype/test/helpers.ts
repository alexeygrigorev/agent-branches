import { inject } from "vitest";

export const SIDECAR_URL = inject("sidecarUrl");
const SIDECAR_TOKEN = inject("sidecarToken");

export { SIDECAR_TOKEN };

export const ADMIN_TOKEN = "test-admin-token";
export const RUNNER_TOKEN = "test-runner-token";

/**
 * Create a REAL commit on a sidecar repo (git plumbing under the hood).
 * Used by worker tests to advance heads the way an agent's `git push` would;
 * the resulting sha is a genuine commit in a genuine bare repo.
 */
export async function sidecarCommit(repo: string, message: string, ref = "refs/heads/main"): Promise<string> {
  const res = await fetch(`${SIDECAR_URL}/api/repos/${encodeURIComponent(repo)}/commits`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SIDECAR_TOKEN}` },
    body: JSON.stringify({ message, ref }),
  });
  if (!res.ok) {
    throw new Error(`sidecar commit on ${repo} failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}
