/**
 * Local CoordinationStore adapters (facade extraction, 2026-10-03):
 * in-memory for tests and embedded use, file-backed for the standalone
 * node:http runtime. Both satisfy the same linearizable get/put port as
 * the Durable Object adapter; concurrent writers are serialized by the
 * core's mutex, so no additional locking is needed in-process.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { CoordinationStore } from "../ports/coordination-store.js";

export class MemoryCoordinationStore implements CoordinationStore {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

/**
 * JSON-file-backed store. Each put rewrites the whole file atomically
 * (tmp file + rename), so a crash mid-write never leaves a torn state —
 * the file always holds the previous complete model or the new one.
 * Model values are plain JSON-safe data (verified by the core's shape).
 */
export class FileCoordinationStore implements CoordinationStore {
  private readonly path: string;
  private cache: Map<string, unknown> | null = null;

  constructor(path: string) {
    this.path = path;
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (this.cache === null) {
      this.cache = await this.loadFile();
    }
    return this.cache.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    if (this.cache === null) {
      this.cache = await this.loadFile();
    }
    this.cache.set(key, value);
    await this.saveFile();
  }

  private async loadFile(): Promise<Map<string, unknown>> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return new Map(Object.entries(parsed));
    } catch (error) {
      // First run (or unreadable state): start empty, exactly like a fresh
      // Durable Object. A CORRUPT file is not silently reset at put time —
      // JSON.parse errors surface to the caller instead of overwriting.
      if ((error as { code?: string }).code === "ENOENT") {
        return new Map();
      }
      throw error;
    }
  }

  private async saveFile(): Promise<void> {
    const slash = this.path.lastIndexOf("/");
    if (slash > 0) {
      await mkdir(this.path.slice(0, slash), { recursive: true });
    }
    const tmp = `${this.path}.tmp`;
    const payload = JSON.stringify(Object.fromEntries(this.cache!), null, 2);
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, this.path);
  }
}
