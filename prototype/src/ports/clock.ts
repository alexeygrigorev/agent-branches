/**
 * Provider-neutral time and identity sources (facade extraction,
 * 2026-10-03). Injected into the core so tests can be deterministic and
 * the core never touches platform globals directly. The defaults use only
 * Web-standard APIs available in both workerd and Node (Date, global
 * crypto.getRandomValues).
 */

export interface Clock {
  /** ISO-8601 UTC timestamp, as `new Date().toISOString()` produces. */
  iso(): string;
}

export const systemClock: Clock = {
  iso: () => new Date().toISOString(),
};

export interface IdGenerator {
  /** 8 lowercase hex chars — the per-instance repo name suffix. */
  suffix(): string;
}

export const cryptoIds: IdGenerator = {
  suffix: () => {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  },
};
