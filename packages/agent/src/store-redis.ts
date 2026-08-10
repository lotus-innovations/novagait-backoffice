// Upstash Redis driver for the Store interface (spec 08 §5, Demo 2 pattern).
// Production only; dev/CI/e2e stay on InMemoryStore so CI needs no secrets.
//
// Upstash gotcha handled here: the REST client auto-deserializes values that
// look like JSON, but our Store contract is strings (callers own JSON).
// Every read therefore re-stringifies non-string values it gets back.

import { Redis } from "@upstash/redis";
import { InMemoryStore, type Store } from "./store";

// The subset of the Upstash client we use; tests inject a fake.
export interface RedisLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts?: { ex?: number }): Promise<unknown>;
  hset(key: string, fields: Record<string, string>): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  rpush(key: string, value: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export class RedisStore implements Store {
  constructor(private readonly redis: RedisLike) {}

  async get(key: string): Promise<string | null> {
    const value = await this.redis.get(key);
    return value === null || value === undefined ? null : asString(value);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.redis.set(
      key,
      value,
      ttlSeconds ? { ex: ttlSeconds } : undefined,
    );
  }

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    await this.redis.hset(key, fields);
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const hash = await this.redis.hgetall(key);
    if (!hash || Object.keys(hash).length === 0) return null;
    const out: Record<string, string> = {};
    for (const [field, value] of Object.entries(hash))
      out[field] = asString(value);
    return out;
  }

  async listPush(key: string, value: string): Promise<number> {
    return this.redis.rpush(key, value);
  }

  async listRange(key: string, start: number, stop: number): Promise<string[]> {
    const items = await this.redis.lrange(key, start, stop);
    return items.map(asString);
  }

  async listTrim(key: string, start: number, stop: number): Promise<void> {
    await this.redis.ltrim(key, start, stop);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(key, ttlSeconds);
  }
}

let memorySingleton: InMemoryStore | null = null;

// Driver selection (Demo 2 pattern): Upstash env present -> redis; otherwise
// a process-wide in-memory store (dev, CI, e2e, previews).
export function createStore(): Store {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) {
    return new RedisStore(new Redis({ url, token }));
  }
  memorySingleton ??= new InMemoryStore();
  return memorySingleton;
}
