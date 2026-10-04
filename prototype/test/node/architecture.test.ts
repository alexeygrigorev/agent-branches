/**
 * Architecture gate (facade extraction, 2026-10-03): the core must stay
 * provider-neutral. Fails if any file under src/core or src/ports imports
 * a Cloudflare-specific module (cloudflare:*, @cloudflare/*, workers-types,
 * wrangler). Runs under plain node --test — no workerd involved.
 */

import { test } from "node:test";
import { ok, strictEqual } from "node:assert";
import { readFile, readdir } from "node:fs/promises";

/** Import specifiers that must never appear in the core or its ports. */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /cloudflare\s*:/i, // cloudflare:workers, cloudflare:test, ...
  /@cloudflare\//i, // @cloudflare/workers-types, @cloudflare/vitest-plugin
  /workers-types/i,
  /\bwrangler\b/i,
];

const IMPORT_SPECIFIER = /(?:\bimport\b|\bexport\b)[^;'"]*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g;

/** Pure matcher, exported for the positive-control test below. */
export function findForbiddenImportSources(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1] ?? match[2];
    if (specifier) {
      specifiers.push(specifier);
    }
  }
  return specifiers.filter((specifier) => FORBIDDEN_PATTERNS.some((pattern) => pattern.test(specifier)));
}

async function coreFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((entry) => entry.endsWith(".ts")).map((entry) => `${dir}/${entry}`);
}

test("architecture: src/core and src/ports import no Cloudflare-specific module", async () => {
  const files = [...(await coreFiles("src/core")), ...(await coreFiles("src/ports"))];
  ok(files.length >= 6, `expected the real core/ports sources, found only: ${files.join(", ")}`);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const violations = findForbiddenImportSources(source);
    strictEqual(violations.length, 0, `${file} imports Cloudflare-specific modules: ${violations.join(", ")}`);
  }
});

test("architecture: the gate itself detects violations (positive control)", () => {
  const violations = findForbiddenImportSources(
    [
      `import { DurableObject } from "cloudflare:workers";`,
      `import type { KVNamespace } from "@cloudflare/workers-types";`,
      `export { X } from "wrangler";`,
      `const m = await import("cloudflare:test");`,
      `import { RadixRouter } from "radix3";`, // fine: not Cloudflare
    ].join("\n"),
  );
  strictEqual(violations.length, 4, `gate missed violations: ${violations.join(", ")}`);
});
