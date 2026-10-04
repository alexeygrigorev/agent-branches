/**
 * Minimal ambient Node typings for the local runtime (facade extraction,
 * 2026-10-03). The repo deliberately has NO @types/node dependency; these
 * declarations cover exactly the surface src/local/ uses, structurally —
 * the real Node builtins satisfy them at runtime. If @types/node is ever
 * added, delete this file and drop the local decls.
 */

declare module "node:http" {
  export interface NodeRequestLike {
    method?: string;
    /** Path with optional query string, e.g. "/status?x=1". */
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: "data", listener: (chunk: Uint8Array | string) => void): void;
    on(event: "end", listener: () => void): void;
    on(event: "error", listener: (error: Error) => void): void;
  }

  export interface NodeResponseLike {
    writeHead(status: number, headers: Record<string, string>): unknown;
    end(body?: string): unknown;
  }

  export interface NodeServerLike {
    listen(port: number, host?: string, callback?: () => void): unknown;
    close(callback?: () => void): unknown;
    address(): { port: number; family: string; address: string } | null;
  }

  export function createServer(
    handler: (request: NodeRequestLike, response: NodeResponseLike) => unknown,
  ): NodeServerLike;
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function mkdir(path: string, options: { recursive?: boolean }): Promise<string | undefined>;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
  export function pathToFileURL(path: string): { href: string };
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): Promise<void>;
  export function test(
    name: string,
    options: { skip?: boolean | string; timeout?: number },
    fn: () => void | Promise<void>,
  ): Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): Promise<void>;
  export function before(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
}

declare module "node:assert" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function match(input: string, regexp: RegExp, message?: string): void;
  export function rejects(promise: Promise<unknown>, expected?: RegExp | Error): Promise<void>;
}

declare module "node:fs/promises" {
  export function readdir(path: string): Promise<string[]>;
  export function readdir(path: string, options: { recursive: true }): Promise<string[]>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode: number;
};

interface ImportMeta {
  url: string;
}
