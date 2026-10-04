import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest((ctx) => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Test-only values injected into the worker under test. Real
          // deployments set these via secrets; see README (auth).
          ADMIN_TOKEN: "test-admin-token",
          RUNNER_TOKEN: "test-runner-token",
          LOCAL_ARTIFACTS_URL: ctx.inject<string>("sidecarUrl"),
          LOCAL_ARTIFACTS_TOKEN: "test-sidecar-token",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // test/node runs under plain `node --test` (npm run test:node) against
    // the local adapters with NO workerd; vitest/workerd must not pick it
    // up (node:http / node:fs imports do not exist in workerd).
    exclude: ["test/node/**", "**/node_modules/**", "**/.build/**"],
    globalSetup: ["test/global-setup.ts"],
    // Real-git sidecar round trips (commit/push per request) are slow under
    // full-suite concurrency; 30s per test avoids flaky timeouts.
    testTimeout: 30_000,
    // Each test file spawns its own workerd while the shared real-git sidecar
    // does real git work per request; parallel files OOM-kill the 1.5 GiB
    // executor sandbox, so files run sequentially (observed by zc-l1-fix).
    fileParallelism: false,
  },
});
