// Versioned pricing table (spec 08 §3, design brief D). Every entry carries
// verifiedOn + source; published numbers cite these fields. Rates are USD per
// million tokens, which equals micro-USD per token exactly, so cost math
// stays in integers.
//
// Cache writes are priced PER TTL (LOT-113). The 5m and 1h prompt caches are
// not the same product: a 5m write bills 1.25x base input, a 1h write bills
// 2.0x. Carrying one multiplier made every 1h-TTL run under-report its cost
// by 60% of its cache-creation tokens, which matters most in exactly the lane
// that uses the 1h TTL (the LOT-105 matrix, CACHE_TTL_BATCH). The multiplier
// is keyed by the same CacheTtl union the loop passes to cache_control, so a
// new TTL cannot be added without pricing it.

import { CACHE_TTL_INTERACTIVE, type CacheTtl } from "./policy-constants";

/** Cache-write premium over base input, per prompt-cache TTL. */
export type CacheWriteMultipliers = Readonly<Record<CacheTtl, number>>;

// Same for every model on the current table; kept as one constant so a
// future model-specific deviation is a visible override, not a silent edit.
const STANDARD_CACHE_WRITE: CacheWriteMultipliers = { "5m": 1.25, "1h": 2.0 };

export interface PricingEntry {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWriteMultiplier: CacheWriteMultipliers;
  cacheReadMultiplier: number;
  verifiedOn: string;
  source: string;
  note?: string;
}

export const PRICING: readonly PricingEntry[] = [
  {
    model: "claude-haiku-4-5",
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cacheWriteMultiplier: STANDARD_CACHE_WRITE,
    cacheReadMultiplier: 0.1,
    verifiedOn: "2026-08-10",
    source: "Anthropic public pricing docs",
  },
  {
    model: "claude-sonnet-5",
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cacheWriteMultiplier: STANDARD_CACHE_WRITE,
    cacheReadMultiplier: 0.1,
    verifiedOn: "2026-08-10",
    source: "Anthropic public pricing docs",
    note: "Was introductory through 2026-08-31; docs now state $2/$10 is the standard price and the 2026-09-01 increase will not occur (re-verified 2026-08-11).",
  },
  {
    model: "claude-opus-5",
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheWriteMultiplier: STANDARD_CACHE_WRITE,
    cacheReadMultiplier: 0.1,
    verifiedOn: "2026-08-10",
    source: "Anthropic public pricing docs",
  },
] as const;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export function pricingFor(model: string): PricingEntry {
  const entry = PRICING.find((p) => p.model === model);
  if (!entry) throw new Error(`No pricing entry for model: ${model}`);
  return entry;
}

/** Cache-write premium for one model at one TTL. */
export function cacheWriteMultiplier(model: string, ttl: CacheTtl): number {
  return pricingFor(model).cacheWriteMultiplier[ttl];
}

// Total prompt size = input_tokens + cache_creation + cache_read;
// usage.input_tokens alone is the uncached remainder only (spec 08 §3).
// `ttl` is the TTL the request's cache_control carried: it selects the cache
// WRITE premium and nothing else (reads are 0.1x at either TTL). Defaults to
// the interactive 5m TTL, which is the loop's own default.
// Returns an integer number of micro-dollars.
export function computeCostMicroUsd(
  model: string,
  usage: Usage,
  ttl: CacheTtl = CACHE_TTL_INTERACTIVE,
): number {
  const p = pricingFor(model);
  const cost =
    usage.input_tokens * p.inputPerMTok +
    usage.cache_creation_input_tokens *
      p.inputPerMTok *
      p.cacheWriteMultiplier[ttl] +
    usage.cache_read_input_tokens * p.inputPerMTok * p.cacheReadMultiplier +
    usage.output_tokens * p.outputPerMTok;
  return Math.round(cost);
}
