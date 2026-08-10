// Versioned pricing table (spec 08 §3, design brief D). Every entry carries
// verifiedOn + source; published numbers cite these fields. Rates are USD per
// million tokens, which equals micro-USD per token exactly, so cost math
// stays in integers.

export interface PricingEntry {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWriteMultiplier: number;
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
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
    verifiedOn: "2026-08-10",
    source: "Anthropic public pricing docs",
  },
  {
    model: "claude-sonnet-5",
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
    verifiedOn: "2026-08-10",
    source: "Anthropic public pricing docs",
    note: "Introductory pricing through 2026-08-31; re-verify after.",
  },
  {
    model: "claude-opus-5",
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheWriteMultiplier: 1.25,
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

// Total prompt size = input_tokens + cache_creation + cache_read;
// usage.input_tokens alone is the uncached remainder only (spec 08 §3).
// Returns an integer number of micro-dollars.
export function computeCostMicroUsd(model: string, usage: Usage): number {
  const p = pricingFor(model);
  const cost =
    usage.input_tokens * p.inputPerMTok +
    usage.cache_creation_input_tokens *
      p.inputPerMTok *
      p.cacheWriteMultiplier +
    usage.cache_read_input_tokens * p.inputPerMTok * p.cacheReadMultiplier +
    usage.output_tokens * p.outputPerMTok;
  return Math.round(cost);
}
