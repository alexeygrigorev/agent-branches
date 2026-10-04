import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSidecar } from "../local-artifacts/sidecar.mjs";

interface GlobalSetupContext {
  provide(key: string, value: unknown): void;
}

/**
 * Boots the local Artifacts sidecar (real bare git repos on disk) once for
 * the whole vitest run; the worker under test reaches it over outbound
 * fetch via the LOCAL_ARTIFACTS_URL binding injected in vitest.config.ts.
 */
export default async function setup(vitest: GlobalSetupContext): Promise<() => Promise<void>> {
  const root = mkdtempSync(join(tmpdir(), "agent-branches-sidecar-vitest-"));
  const handle = await startSidecar({
    root,
    host: "127.0.0.1",
    port: 0,
    token: "test-sidecar-token",
    notifyUrl: null,
  });
  const sidecarUrl = `http://127.0.0.1:${handle.port}`;
  vitest.provide("sidecarUrl", sidecarUrl);
  vitest.provide("sidecarToken", "test-sidecar-token");
  console.error(`[global-setup] sidecar on ${sidecarUrl} (root ${root})`);
  return async () => {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  };
}
