/**
 * Cloudflare CoordinationStore adapter (facade extraction, 2026-10-03):
 * Durable Object storage backs the transactional get/put port. Durability
 * and single-object linearizability come from DO storage; concurrent
 * writers are serialized by the core's mutex, exactly as pre-facade.
 */

import type { CoordinationStore } from "../ports/coordination-store.js";

export class DurableObjectCoordinationStore implements CoordinationStore {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.state.storage.get<T>(key);
  }

  put<T>(key: string, value: T): Promise<void> {
    return this.state.storage.put(key, value);
  }
}
