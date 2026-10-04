import { expect, it, inject } from "vitest";

it("worker runtime can reach the Node sidecar over outbound fetch", async () => {
  const url = inject("sidecarUrl");
  const token = inject("sidecarToken");
  const res = await fetch(`${url}/api/health`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; repos: number };
  expect(body.ok).toBe(true);
});
