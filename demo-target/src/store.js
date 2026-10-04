export class MemoryStore {
  constructor() {
    this.data = new Map();
  }

  put(key, value) {
    this.data.set(key, value);
  }

  get(key) {
    return this.data.get(key) ?? null;
  }

  has(key) {
    return this.data.has(key);
  }

  keys() {
    return [...this.data.keys()];
  }
}
