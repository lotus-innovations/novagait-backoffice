import { describe, expect, it } from "vitest";
import { RunStateMachine } from "./run-state";
import { InMemoryStore } from "./store";
import { RedisStore, type RedisLike } from "./store-redis";

async function freshMachine(store = new InMemoryStore()) {
  const machine = await RunStateMachine.create(store, {
    run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    mode: "assisted",
    input_ref: "inbox/2026-08-03-corvida-monthly.md",
  });
  return { store, machine };
}

describe("RunStateMachine", () => {
  it("walks the full approval path and persists each step", async () => {
    const { store, machine } = await freshMachine();
    await machine.transition("extracted", { total_cents: 43875 });
    await machine.transition("matched", { po: "PO-2201" });
    await machine.transition("decided", { decision: "route_for_approval" });
    await machine.transition("awaiting_approval", { approval_id: "APR-1" });
    await machine.transition("executed");
    expect(machine.isTerminal).toBe(true);

    const loaded = await RunStateMachine.load(
      store,
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    expect(loaded?.state.step).toBe("executed");
    expect(loaded?.state.data.total_cents).toBe(43875);
    expect(loaded?.state.data.approval_id).toBe("APR-1");
  });

  it("allows exactly one revision cycle from awaiting_approval", async () => {
    const { machine } = await freshMachine();
    await machine.transition("extracted");
    await machine.transition("matched");
    await machine.transition("decided");
    await machine.transition("awaiting_approval");
    await machine.transition("decided", { revision_reason: "wrong GL code" });
    expect(machine.state.revision_count).toBe(1);
    await machine.transition("awaiting_approval");
    await expect(machine.transition("decided")).rejects.toThrow(/revision cap/);
  });

  it("rejects invalid transitions", async () => {
    const { machine } = await freshMachine();
    await expect(machine.transition("executed")).rejects.toThrow(
      /invalid transition ingested -> executed/,
    );
    await expect(machine.transition("awaiting_approval")).rejects.toThrow(
      /invalid transition/,
    );
  });

  it("terminal states are immutable", async () => {
    const { machine } = await freshMachine();
    await machine.transition("rejected");
    expect(machine.isTerminal).toBe(true);
    await expect(machine.transition("extracted")).rejects.toThrow(/terminal/);
  });

  it("allows breaker aborts from any non-terminal step", async () => {
    const { machine } = await freshMachine();
    await machine.transition("extracted");
    await machine.transition("cost_capped", { spent_micro_usd: 20000 });
    expect(machine.isTerminal).toBe(true);
    expect(machine.state.data.spent_micro_usd).toBe(20000);
  });

  it("load returns null for unknown runs", async () => {
    const store = new InMemoryStore();
    expect(await RunStateMachine.load(store, "NOPE")).toBeNull();
  });
});

describe("RedisStore driver mapping", () => {
  function fakeRedis() {
    const kv = new Map<string, unknown>();
    const lists = new Map<string, string[]>();
    const hashes = new Map<string, Record<string, string>>();
    const calls: string[] = [];
    const client: RedisLike = {
      async get(key) {
        calls.push(`get:${key}`);
        const value = kv.get(key) ?? null;
        // Simulate the Upstash REST client auto-deserializing JSON strings.
        if (typeof value === "string") {
          try {
            return JSON.parse(value);
          } catch {
            return value;
          }
        }
        return value;
      },
      async set(key, value, opts) {
        calls.push(`set:${key}:ex=${opts?.ex ?? "none"}`);
        kv.set(key, value);
        return "OK";
      },
      async hset(key, fields) {
        hashes.set(key, { ...(hashes.get(key) ?? {}), ...fields });
        return Object.keys(fields).length;
      },
      async hgetall(key) {
        return hashes.get(key) ?? null;
      },
      async rpush(key, value) {
        const list = lists.get(key) ?? [];
        list.push(value);
        lists.set(key, list);
        return list.length;
      },
      async lrange(key, start, stop) {
        const list = lists.get(key) ?? [];
        return list.slice(start, stop === -1 ? undefined : stop + 1);
      },
      async ltrim(key, start, stop) {
        const list = lists.get(key) ?? [];
        lists.set(key, list.slice(start, stop === -1 ? undefined : stop + 1));
        return "OK";
      },
      async expire(key) {
        calls.push(`expire:${key}`);
        return 1;
      },
      async del(...keys) {
        calls.push(`del:${keys.join(",")}`);
        let removed = 0;
        for (const key of keys) {
          if (kv.delete(key) || lists.delete(key) || hashes.delete(key))
            removed++;
        }
        return removed;
      },
      async incrby(key, delta) {
        const next = Number(kv.get(key) ?? 0) + delta;
        kv.set(key, String(next));
        return next;
      },
    };
    return { client, calls };
  }

  it("re-stringifies auto-deserialized JSON so the Store contract holds", async () => {
    const { client } = fakeRedis();
    const store = new RedisStore(client);
    const payload = JSON.stringify({ step: "decided", n: 2 });
    await store.set("runstate:R1", payload, 60);
    const roundTrip = await store.get("runstate:R1");
    expect(typeof roundTrip).toBe("string");
    expect(JSON.parse(roundTrip!)).toEqual({ step: "decided", n: 2 });
  });

  it("passes TTLs through set and supports the state machine end to end", async () => {
    const { client, calls } = fakeRedis();
    const store = new RedisStore(client);
    const machine = await RunStateMachine.create(store, {
      run_id: "R2",
      mode: "shadow",
      input_ref: "inbox/x.md",
    });
    await machine.transition("extracted");
    const loaded = await RunStateMachine.load(store, "R2");
    expect(loaded?.state.step).toBe("extracted");
    expect(
      calls.some((call) => call.startsWith("set:runstate:R2:ex=86400")),
    ).toBe(true);
  });
});
