/**
 * Provider-neutral persistence port for the coordinator state (facade
 * extraction, 2026-10-03).
 *
 * Serialization guarantee: a `put` that has resolved is durable and visible
 * to every later `get`, and values are stored/restored losslessly (JSON in
 * the local adapters, structured clone in the Durable Object adapter).
 * Writers are serialized by the CORE (the coordinator's `serialized()`
 * mutex, codex C-1305 #4); adapters must not reorder concurrent puts.
 */

export interface CoordinationStore {
  /** Latest value stored under `key`, or undefined before the first put. */
  get<T>(key: string): Promise<T | undefined>;

  /** Atomically replace the value under `key`. */
  put<T>(key: string, value: T): Promise<void>;
}
