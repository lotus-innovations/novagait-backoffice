// Cache-write pricing is TTL-dependent (LOT-113). These tests pin BOTH TTLs
// with hand-computed numbers so a future edit to the table cannot quietly
// re-collapse the two into one multiplier.

import { describe, expect, it } from "vitest";
import { CACHE_TTL_BATCH, CACHE_TTL_INTERACTIVE } from "./policy-constants";
import {
  PRICING,
  cacheWriteMultiplier,
  computeCostMicroUsd,
  pricingFor,
} from "./pricing";

const USAGE = {
  input_tokens: 1000,
  cache_creation_input_tokens: 4096,
  cache_read_input_tokens: 10000,
  output_tokens: 500,
};

describe("cache-write multipliers", () => {
  it("prices a 5m write at 1.25x and a 1h write at 2.0x on every model", () => {
    for (const entry of PRICING) {
      expect(cacheWriteMultiplier(entry.model, CACHE_TTL_INTERACTIVE)).toBe(
        1.25,
      );
      expect(cacheWriteMultiplier(entry.model, CACHE_TTL_BATCH)).toBe(2.0);
    }
  });

  it("reads 0.1x at either TTL", () => {
    for (const entry of PRICING) {
      expect(entry.cacheReadMultiplier).toBe(0.1);
    }
  });
});

describe("computeCostMicroUsd", () => {
  it("defaults to the interactive 5m TTL", () => {
    // 1000*1 + 4096*1*1.25 + 10000*1*0.1 + 500*5 = 1000+5120+1000+2500
    expect(computeCostMicroUsd("claude-haiku-4-5", USAGE)).toBe(9620);
    expect(
      computeCostMicroUsd("claude-haiku-4-5", USAGE, CACHE_TTL_INTERACTIVE),
    ).toBe(9620);
  });

  it("bills a 1h-TTL cache write at 2.0x base input", () => {
    // 1000*1 + 4096*1*2.0 + 10000*1*0.1 + 500*5 = 1000+8192+1000+2500
    expect(
      computeCostMicroUsd("claude-haiku-4-5", USAGE, CACHE_TTL_BATCH),
    ).toBe(12692);
  });

  it("charges the TTL delta only on cache-creation tokens", () => {
    const delta =
      computeCostMicroUsd("claude-sonnet-5", USAGE, CACHE_TTL_BATCH) -
      computeCostMicroUsd("claude-sonnet-5", USAGE, CACHE_TTL_INTERACTIVE);
    const entry = pricingFor("claude-sonnet-5");
    expect(delta).toBe(
      Math.round(
        USAGE.cache_creation_input_tokens * entry.inputPerMTok * (2.0 - 1.25),
      ),
    );
  });

  it("is TTL-insensitive when nothing was written to cache", () => {
    const noWrite = { ...USAGE, cache_creation_input_tokens: 0 };
    expect(computeCostMicroUsd("claude-opus-5", noWrite, CACHE_TTL_BATCH)).toBe(
      computeCostMicroUsd("claude-opus-5", noWrite, CACHE_TTL_INTERACTIVE),
    );
  });

  it("returns integer micro-USD at both TTLs", () => {
    for (const ttl of [CACHE_TTL_INTERACTIVE, CACHE_TTL_BATCH] as const) {
      for (const entry of PRICING) {
        expect(
          Number.isInteger(computeCostMicroUsd(entry.model, USAGE, ttl)),
        ).toBe(true);
      }
    }
  });
});
