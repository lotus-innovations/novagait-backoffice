import { afterEach, describe, expect, it } from "vitest";
import {
  budgetKey,
  checkIpLimit,
  checkSessionCap,
  getDailySpendMicroUsd,
  isCapacityMode,
  recordRunCost,
} from "./containment";
import {
  DAILY_BUDGET_MICRO_USD,
  IP_LIMIT_PER_DAY,
  IP_LIMIT_PER_HOUR,
  SESSION_RUN_CAP,
} from "./policy-constants";
import { InMemoryStore } from "./store";

// Fixed anchor mid-window so two-bucket weighting is deterministic.
const NOW = Date.parse("2026-08-10T12:30:00Z");

afterEach(() => {
  delete process.env.RATE_LIMIT_PER_HOUR;
  delete process.env.RATE_LIMIT_PER_DAY;
  delete process.env.SESSION_RUN_CAP;
});

describe("checkIpLimit", () => {
  it("allows up to the hourly limit and then blocks with a reason", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < IP_LIMIT_PER_HOUR; i++) {
      expect((await checkIpLimit(store, "1.2.3.4", NOW)).allowed).toBe(true);
    }
    const blocked = await checkIpLimit(store, "1.2.3.4", NOW);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("hourly");
  });

  it("enforces the daily limit across hourly windows", async () => {
    const store = new InMemoryStore();
    let now = NOW;
    let allowed = 0;
    // Spread requests over many hours so the hourly limit never trips.
    for (let i = 0; i < IP_LIMIT_PER_DAY + 5; i++) {
      const result = await checkIpLimit(store, "5.6.7.8", now);
      if (result.allowed) allowed++;
      else expect(result.reason).toContain("daily");
      if ((i + 1) % 5 === 0) now += 60 * 60 * 1000;
    }
    // Exactly the cap: a weaker bound would also pass if the limiter
    // blocked everything after the first request.
    expect(allowed).toBe(IP_LIMIT_PER_DAY);
  });

  it("falls back to policy limits when an env override is malformed (fail closed)", async () => {
    process.env.RATE_LIMIT_PER_HOUR = "not-a-number";
    const store = new InMemoryStore();
    let allowed = 0;
    for (let i = 0; i < IP_LIMIT_PER_HOUR + 3; i++) {
      if ((await checkIpLimit(store, "8.8.8.8", NOW)).allowed) allowed++;
    }
    expect(allowed).toBe(IP_LIMIT_PER_HOUR);
  });

  it("tracks IPs independently", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < IP_LIMIT_PER_HOUR; i++) {
      await checkIpLimit(store, "1.1.1.1", NOW);
    }
    expect((await checkIpLimit(store, "2.2.2.2", NOW)).allowed).toBe(true);
  });

  it("honors the e2e env override", async () => {
    process.env.RATE_LIMIT_PER_HOUR = "2";
    const store = new InMemoryStore();
    expect((await checkIpLimit(store, "9.9.9.9", NOW)).allowed).toBe(true);
    expect((await checkIpLimit(store, "9.9.9.9", NOW)).allowed).toBe(true);
    expect((await checkIpLimit(store, "9.9.9.9", NOW)).allowed).toBe(false);
  });
});

describe("checkSessionCap", () => {
  it("allows the cap then blocks", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < SESSION_RUN_CAP; i++) {
      expect((await checkSessionCap(store, "s1")).allowed).toBe(true);
    }
    const blocked = await checkSessionCap(store, "s1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("session cap");
    expect((await checkSessionCap(store, "s2")).allowed).toBe(true);
  });
});

describe("budget counter + capacity mode", () => {
  it("accumulates cost under a UTC day key and trips the breaker", async () => {
    const store = new InMemoryStore();
    expect(budgetKey(NOW)).toBe("budget:2026-08-10");
    expect(await isCapacityMode(store, NOW)).toBe(false);
    await recordRunCost(store, 400_000, NOW);
    expect(await getDailySpendMicroUsd(store, NOW)).toBe(400_000);
    expect(await isCapacityMode(store, NOW)).toBe(false);
    await recordRunCost(store, DAILY_BUDGET_MICRO_USD - 400_000, NOW);
    expect(await isCapacityMode(store, NOW)).toBe(true);
    // Next UTC day: fresh counter.
    expect(await isCapacityMode(store, NOW + 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("zero-cost runs (mock lane) do not create keys", async () => {
    const store = new InMemoryStore();
    expect(await recordRunCost(store, 0, NOW)).toBe(0);
    expect(await getDailySpendMicroUsd(store, NOW)).toBe(0);
  });
});
