// Single source for every policy threshold (spec 07 §5-6, spec 13 §1,
// Abhinav-approved [DEFAULT]s 2026-08-10). The system prompt, the autonomy
// policy function, the guardrails, and the eval graders all read from here;
// a threshold that appears anywhere else as a literal is a bug.

export const AUTONOMY_CAP_CENTS = 50_000; // $500: above this, human approval
export const HARD_FLOOR_CENTS = 500_000; // $5,000: autonomy never applies

export const PRICE_TOLERANCE_PCT = 0.02; // max(2%, $25) per matched line
export const PRICE_TOLERANCE_MIN_CENTS = 2_500;

export const VENDOR_MATCH_THRESHOLD = 0.9; // Jaro-Winkler floor for fuzzy match

export const MAX_ITERATIONS = 10; // loop cap (spec 13 §1, raised 8->10 LOT-119)
export const RUN_WALL_CLOCK_MS = 90_000;
export const MAX_RUN_COST_MICRO_USD = 20_000; // $0.02 per run

// Prompt-cache TTLs (LOT-119). The cacheable prefix is system+tools; the
// breakpoint that marks it lives in loop.ts. Interactive runs are minutes
// apart at most, so the cheaper 5m write pays for itself on the second run;
// a batch or eval lane can idle far longer between runs, and the docs
// recommend the 1h TTL for batches (2x write, but it survives the gap).
export const CACHE_TTL_INTERACTIVE = "5m" as const;
export const CACHE_TTL_BATCH = "1h" as const;
export type CacheTtl = typeof CACHE_TTL_INTERACTIVE | typeof CACHE_TTL_BATCH;

// Containment layers (spec 13 §1, LOT-103).
export const DAILY_BUDGET_MICRO_USD = 1_000_000; // $1.00/day, then capacity mode
export const SESSION_RUN_CAP = 5; // runs per visitor session
export const IP_LIMIT_PER_HOUR = 10;
export const IP_LIMIT_PER_DAY = 30;
export const INTAKE_NOTE_MAX_CHARS = 280;

export function priceToleranceCents(poLineTotalCents: number): number {
  return Math.max(
    Math.round(poLineTotalCents * PRICE_TOLERANCE_PCT),
    PRICE_TOLERANCE_MIN_CENTS,
  );
}
