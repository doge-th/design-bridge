// Task mapping: Design polls OUR task ids; we translate them to the bridged
// provider's task ids. Persisted to disk so tasks survive a bridge restart
// (the Design app polls for a long time).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class TaskMap {
  constructor(stateFile, ttlHours = 72) {
    this.stateFile = stateFile;
    this.ttlMs = ttlHours > 0 ? ttlHours * 3600_000 : Infinity;
    this.map = new Map(); // bridgeTaskId -> { providerTaskId, provider, createdAt }
    this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.stateFile)) return;
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf-8'));
      for (const [id, rec] of Object.entries(raw)) {
        this.map.set(id, rec);
      }
      this.#prune();
    } catch {
      // corrupt state file is not fatal — start with an empty map
    }
  }

  #prune() {
    const now = Date.now();
    for (const [id, rec] of this.map) {
      if (now - rec.createdAt > this.ttlMs) this.map.delete(id);
    }
  }

  #save() {
    try {
      writeFileSync(this.stateFile, JSON.stringify(Object.fromEntries(this.map), null, 2));
    } catch {
      // best effort persistence
    }
  }

  /** Create a new bridge task id for a provider task id. */
  create(providerTaskId, provider) {
    const bridgeTaskId = randomUUID();
    this.map.set(bridgeTaskId, { providerTaskId, provider, createdAt: Date.now() });
    this.#save();
    return bridgeTaskId;
  }

  get(bridgeTaskId) {
    return this.map.get(bridgeTaskId) ?? null;
  }
}
