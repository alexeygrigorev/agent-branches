/**
 * Web-standard globals for the NODE build only (facade extraction,
 * 2026-10-03). This file is referenced exclusively by tsconfig.node.json —
 * the main (workerd) build gets these from worker-configuration.d.ts, and
 * redeclaring them there would collide. Node ≥18 ships all of these
 * natively; the declarations are the minimal structural surface src/core,
 * src/ports and src/local actually use. Keeping this list tiny is the
 * point: nothing DOM-shaped (Request, Response, fetch) becomes available
 * to the core build, so the no-Cloudflare boundary stays enforced.
 */

declare const crypto: {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  subtle: {
    digest(algorithm: "SHA-256", data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
  };
};

declare const TextEncoder: {
  new (): { encode(input?: string): Uint8Array };
};

declare const TextDecoder: {
  new (): { decode(input?: Uint8Array): string };
};

declare const URLSearchParams: {
  new (init?: string): {
    set(name: string, value: string): void;
    toString(): string;
  };
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

/** Minimal client surface used by the node --test suite. */
declare function fetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
