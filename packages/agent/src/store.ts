// Minimal key-value store contract for trace + run state (spec 08 §5).
// Two drivers by design (Demo 2 pattern): in-memory for dev/CI/e2e here;
// the Upstash Redis driver lands with run-state wiring (LOT-88).
// All values are strings; callers own (de)serialization.

export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  hset(key: string, fields: Record<string, string>): Promise<void>;
  hgetall(key: string): Promise<Record<string, string> | null>;
  listPush(key: string, value: string): Promise<number>;
  listRange(key: string, start: number, stop: number): Promise<string[]>;
  listTrim(key: string, start: number, stop: number): Promise<void>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  /** Delete keys of any type. No-op for keys that do not exist (LOT-92). */
  del(keys: string[]): Promise<void>;
  /**
   * Atomic integer increment; creates the key at delta if absent. TTL is
   * applied only on creation (LOT-103: rate/budget/session counters).
   */
  incrBy(key: string, delta: number, ttlSeconds?: number): Promise<number>;
}

interface Entry {
  value: string | string[] | Record<string, string>;
  expiresAt: number | null;
}

export class InMemoryStore implements Store {
  private data = new Map<string, Entry>();

  private live(key: string): Entry | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.live(key);
    return typeof entry?.value === "string" ? entry.value : null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.data.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    const entry = this.live(key);
    const hash =
      entry && !Array.isArray(entry.value) && typeof entry.value === "object"
        ? { ...entry.value }
        : {};
    Object.assign(hash, fields);
    this.data.set(key, { value: hash, expiresAt: entry?.expiresAt ?? null });
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const entry = this.live(key);
    if (!entry || Array.isArray(entry.value) || typeof entry.value !== "object")
      return null;
    return { ...entry.value };
  }

  async listPush(key: string, value: string): Promise<number> {
    const entry = this.live(key);
    const list = entry && Array.isArray(entry.value) ? entry.value : [];
    list.push(value);
    this.data.set(key, { value: list, expiresAt: entry?.expiresAt ?? null });
    return list.length;
  }

  async listRange(key: string, start: number, stop: number): Promise<string[]> {
    const entry = this.live(key);
    if (!entry || !Array.isArray(entry.value)) return [];
    const list = entry.value;
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }

  async listTrim(key: string, start: number, stop: number): Promise<void> {
    const entry = this.live(key);
    if (!entry || !Array.isArray(entry.value)) return;
    const list = entry.value;
    const end = stop === -1 ? list.length : stop + 1;
    this.data.set(key, {
      value: list.slice(start, end),
      expiresAt: entry.expiresAt,
    });
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    const entry = this.live(key);
    if (!entry) return;
    entry.expiresAt = Date.now() + ttlSeconds * 1000;
  }

  async del(keys: string[]): Promise<void> {
    for (const key of keys) this.data.delete(key);
  }

  async incrBy(
    key: string,
    delta: number,
    ttlSeconds?: number,
  ): Promise<number> {
    const entry = this.live(key);
    const parsed =
      entry && typeof entry.value === "string" ? Number(entry.value) : 0;
    // Non-numeric residue must not poison the counter as NaN (a NaN budget
    // counter silently disables the capacity breaker). Redis errors loudly
    // on this; match by resetting to a clean base.
    const current = Number.isFinite(parsed) ? parsed : 0;
    const next = current + delta;
    this.data.set(key, {
      value: String(next),
      expiresAt: entry
        ? entry.expiresAt
        : ttlSeconds
          ? Date.now() + ttlSeconds * 1000
          : null,
    });
    return next;
  }
}
