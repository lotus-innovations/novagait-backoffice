// Containment layers (spec 13 §1, LOT-103): per-IP rate limits, per-session
// run cap, and the daily budget breaker behind capacity mode. All values
// come from policy-constants; env overrides exist only so the e2e lane
// (single localhost IP) does not trip the limits.

import {
  DAILY_BUDGET_MICRO_USD,
  IP_LIMIT_PER_DAY,
  IP_LIMIT_PER_HOUR,
  SESSION_RUN_CAP,
} from "./policy-constants";
import type { Store } from "./store";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function limitOverride(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw ? Number(raw) : fallback;
}

export interface LimitCheck {
  allowed: boolean;
  reason: string | null;
}

/**
 * Two-bucket sliding window (Demo 2 ratelimit.ts pattern): previous fixed
 * window weighted by the un-elapsed fraction of the current one.
 */
async function slidingCount(
  store: Store,
  prefix: string,
  windowMs: number,
  nowMs: number,
): Promise<{ weighted: number; currentKey: string }> {
  const bucket = Math.floor(nowMs / windowMs);
  const elapsedFraction = (nowMs % windowMs) / windowMs;
  const currentKey = `${prefix}:${bucket}`;
  const prevKey = `${prefix}:${bucket - 1}`;
  const [current, prev] = await Promise.all([
    store.get(currentKey),
    store.get(prevKey),
  ]);
  const weighted =
    Number(current ?? 0) + Number(prev ?? 0) * (1 - elapsedFraction);
  return { weighted, currentKey };
}

/** 10/hr + 30/day per IP; counts only on allowed requests. */
export async function checkIpLimit(
  store: Store,
  ip: string,
  nowMs = Date.now(),
): Promise<LimitCheck> {
  const perHour = limitOverride("RATE_LIMIT_PER_HOUR", IP_LIMIT_PER_HOUR);
  const perDay = limitOverride("RATE_LIMIT_PER_DAY", IP_LIMIT_PER_DAY);
  const hour = await slidingCount(store, `rate:h:${ip}`, HOUR_MS, nowMs);
  if (hour.weighted >= perHour) {
    return { allowed: false, reason: `hourly limit (${perHour} runs/hour)` };
  }
  const day = await slidingCount(store, `rate:d:${ip}`, DAY_MS, nowMs);
  if (day.weighted >= perDay) {
    return { allowed: false, reason: `daily limit (${perDay} runs/day)` };
  }
  await store.incrBy(hour.currentKey, 1, 2 * 60 * 60);
  await store.incrBy(day.currentKey, 1, 2 * 24 * 60 * 60);
  return { allowed: true, reason: null };
}

/** 5 runs per visitor session, 24h horizon. */
export async function checkSessionCap(
  store: Store,
  sessionId: string,
): Promise<LimitCheck> {
  const cap = limitOverride("SESSION_RUN_CAP", SESSION_RUN_CAP);
  const count = await store.incrBy(
    `session:${sessionId}:runs`,
    1,
    DAY_MS / 1000,
  );
  if (count > cap) {
    return {
      allowed: false,
      reason: `session cap (${cap} runs per visit) reached`,
    };
  }
  return { allowed: true, reason: null };
}

/** UTC day stamp for the budget counter key. */
export function budgetKey(nowMs = Date.now()): string {
  return `budget:${new Date(nowMs).toISOString().slice(0, 10)}`;
}

/** Accumulate a run's measured cost into the daily budget counter. */
export async function recordRunCost(
  store: Store,
  costMicroUsd: number,
  nowMs = Date.now(),
): Promise<number> {
  if (costMicroUsd <= 0) {
    return Number((await store.get(budgetKey(nowMs))) ?? 0);
  }
  return store.incrBy(budgetKey(nowMs), costMicroUsd, 2 * 24 * 60 * 60);
}

export async function getDailySpendMicroUsd(
  store: Store,
  nowMs = Date.now(),
): Promise<number> {
  return Number((await store.get(budgetKey(nowMs))) ?? 0);
}

/** Capacity mode (spec 13 §2): daily breaker tripped; intake disabled. */
export async function isCapacityMode(
  store: Store,
  nowMs = Date.now(),
): Promise<boolean> {
  return (await getDailySpendMicroUsd(store, nowMs)) >= DAILY_BUDGET_MICRO_USD;
}
