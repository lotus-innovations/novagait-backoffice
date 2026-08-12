// Cost model for the LOT-105 live matrix (spec 09 §4, spec 13 §3).
//
// Every rate here was verified against official Anthropic docs on the date
// stamped in PRICING_VERIFIED_ON; sources are carried through to the
// workpaper so a published number can be traced to a page.

import type { CaseMeasurement, JudgeMeasurement, MatrixModel } from "./measure";
import { MATRIX_MODELS } from "./measure";

export const PRICING_VERIFIED_ON = "2026-08-11";

export const PRICING_SOURCES = {
  pricing: "https://platform.claude.com/docs/en/about-claude/pricing",
  batch:
    "https://platform.claude.com/docs/en/build-with-claude/batch-processing",
  caching:
    "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
  tokenCounting:
    "https://platform.claude.com/docs/en/build-with-claude/token-counting",
} as const;

export interface ModelPricing {
  model: MatrixModel;
  inputPerMTok: number;
  outputPerMTok: number;
  minCacheablePrefixTokens: number;
}

export const PRICING: Record<MatrixModel, ModelPricing> = {
  "claude-haiku-4-5": {
    model: "claude-haiku-4-5",
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    minCacheablePrefixTokens: 4096,
  },
  "claude-sonnet-5": {
    model: "claude-sonnet-5",
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    minCacheablePrefixTokens: 1024,
  },
  "claude-opus-5": {
    model: "claude-opus-5",
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    minCacheablePrefixTokens: 512,
  },
};

export const BATCH_DISCOUNT = 0.5; // 50% off BOTH input and output
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0; // 1h TTL: recommended for batch
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CONTINGENCY = 1.3;

// Batch cache hits are best-effort; the docs quote a 30-98% observed range.
export const CACHE_HIT_SCENARIOS = [0.98, 0.9, 0.7, 0.3] as const;

const perTok = (perMTok: number) => perMTok / 1_000_000;

export interface ModelAggregate {
  model: MatrixModel;
  cases: number;
  prefixTokens: number;
  cacheApplies: boolean;
  totalInputTokens: number;
  totalSuffixTokens: number;
  totalPrefixTokens: number; // prefix re-read once per iteration, per case
  totalOutputTokens: number;
  meanInputTokensPerRun: number;
  meanOutputTokensPerRun: number;
  meanIterations: number;
}

export function aggregate(measurements: CaseMeasurement[]): ModelAggregate[] {
  return MATRIX_MODELS.map((model) => {
    const rows = measurements.filter((m) => m.model === model);
    const prefixTokens = rows[0]?.prefixTokens ?? 0;
    const totalInputTokens = rows.reduce((a, r) => a + r.totalInputTokens, 0);
    const totalSuffixTokens = rows.reduce((a, r) => a + r.totalSuffixTokens, 0);
    const totalOutputTokens = rows.reduce((a, r) => a + r.totalOutputTokens, 0);
    const iterations = rows.reduce((a, r) => a + r.iterations, 0);
    return {
      model,
      cases: rows.length,
      prefixTokens,
      cacheApplies: prefixTokens >= PRICING[model].minCacheablePrefixTokens,
      totalInputTokens,
      totalSuffixTokens,
      totalPrefixTokens: totalInputTokens - totalSuffixTokens,
      totalOutputTokens,
      meanInputTokensPerRun: totalInputTokens / Math.max(1, rows.length),
      meanOutputTokensPerRun: totalOutputTokens / Math.max(1, rows.length),
      meanIterations: iterations / Math.max(1, rows.length),
    };
  });
}

export interface MatrixCellCost {
  model: MatrixModel;
  mode: "uncached" | "cached";
  cacheHitRate: number | null;
  inputCostUsd: number;
  outputCostUsd: number;
  totalUsd: number;
  costPerRunUsd: number;
  note?: string;
}

export function uncachedCell(agg: ModelAggregate): MatrixCellCost {
  const p = PRICING[agg.model];
  const inputCostUsd =
    agg.totalInputTokens * perTok(p.inputPerMTok) * BATCH_DISCOUNT;
  const outputCostUsd =
    agg.totalOutputTokens * perTok(p.outputPerMTok) * BATCH_DISCOUNT;
  return {
    model: agg.model,
    mode: "uncached",
    cacheHitRate: null,
    inputCostUsd,
    outputCostUsd,
    totalUsd: inputCostUsd + outputCostUsd,
    costPerRunUsd: (inputCostUsd + outputCostUsd) / Math.max(1, agg.cases),
  };
}

/**
 * Cached column. Only the system+tools prefix is shared across the 73 cases,
 * so only that span is cacheable; per-case conversation growth is always
 * billed at base input. A miss is priced as a 1h cache WRITE (2.0x), not as
 * plain input, because a missed batch request still writes the entry.
 */
export function cachedCell(
  agg: ModelAggregate,
  hitRate: number,
): MatrixCellCost {
  const p = PRICING[agg.model];
  if (!agg.cacheApplies) {
    const fallback = uncachedCell(agg);
    return {
      ...fallback,
      mode: "cached",
      cacheHitRate: hitRate,
      note:
        `prefix ${agg.prefixTokens} tok < ${p.minCacheablePrefixTokens} tok minimum ` +
        `for ${agg.model}: cache_control is silently ignored, so the cached ` +
        `column equals the uncached column`,
    };
  }
  const prefixFactor =
    hitRate * CACHE_READ_MULTIPLIER + (1 - hitRate) * CACHE_WRITE_1H_MULTIPLIER;
  const inputCostUsd =
    (agg.totalPrefixTokens * prefixFactor + agg.totalSuffixTokens) *
    perTok(p.inputPerMTok) *
    BATCH_DISCOUNT;
  const outputCostUsd =
    agg.totalOutputTokens * perTok(p.outputPerMTok) * BATCH_DISCOUNT;
  return {
    model: agg.model,
    mode: "cached",
    cacheHitRate: hitRate,
    inputCostUsd,
    outputCostUsd,
    totalUsd: inputCostUsd + outputCostUsd,
    costPerRunUsd: (inputCostUsd + outputCostUsd) / Math.max(1, agg.cases),
  };
}

export interface JudgeCost {
  model: string;
  role: "working" | "published";
  judgedResults: number;
  inputTokens: number;
  outputTokens: number;
  totalUsd: number;
}

const JUDGE_PRICING: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 2.0, out: 10.0 },
  "claude-opus-5": { in: 5.0, out: 25.0 },
};

export function judgeCost(
  m: JudgeMeasurement,
  role: "working" | "published",
  judgedResults: number,
  batch = true,
): JudgeCost {
  const p = JUDGE_PRICING[m.model];
  const discount = batch ? BATCH_DISCOUNT : 1;
  const inputTokens = m.meanInputTokens * judgedResults;
  const outputTokens = m.meanOutputTokens * judgedResults;
  return {
    model: m.model,
    role,
    judgedResults,
    inputTokens,
    outputTokens,
    totalUsd:
      (inputTokens * perTok(p.in) + outputTokens * perTok(p.out)) * discount,
  };
}

export interface LatencyPassCost {
  cases: number;
  models: number;
  repetitions: number;
  runs: number;
  totalUsd: number;
  perModelUsd: { model: MatrixModel; totalUsd: number }[];
}

/**
 * Interactive latency lane (spec 09 §4, spec 13 §3): "a separate small live
 * pass", size not fixed by the spec. Sized here at a P0 subset x 3 models x
 * 3 repetitions (p50/p95 need repeats), non-batch, uncached - the
 * conservative reading on every axis.
 */
export function latencyPassCost(
  aggregates: ModelAggregate[],
  cases = 12,
  repetitions = 3,
): LatencyPassCost {
  const perModelUsd = aggregates.map((agg) => {
    const p = PRICING[agg.model];
    const runs = cases * repetitions;
    const totalUsd =
      (agg.meanInputTokensPerRun * perTok(p.inputPerMTok) +
        agg.meanOutputTokensPerRun * perTok(p.outputPerMTok)) *
      runs;
    return { model: agg.model, totalUsd };
  });
  return {
    cases,
    models: aggregates.length,
    repetitions,
    runs: cases * repetitions * aggregates.length,
    totalUsd: perModelUsd.reduce((a, m) => a + m.totalUsd, 0),
    perModelUsd,
  };
}

export interface SpendEstimate {
  generatedOn: string;
  pricingVerifiedOn: string;
  caseCount: number;
  aggregates: ModelAggregate[];
  matrix: {
    uncached: MatrixCellCost[];
    cached: Record<string, MatrixCellCost[]>; // keyed by hit-rate string
  };
  judge: JudgeCost[];
  calibration: JudgeCost[];
  latencyPass: LatencyPassCost;
  totals: {
    matrixUncachedUsd: number;
    matrixCachedBestUsd: number;
    matrixCachedWorstUsd: number;
    judgeUsd: number;
    calibrationUsd: number;
    latencyUsd: number;
    rawUsd: number;
    rawUsdCachedBest: number;
    withContingencyUsd: number;
    withContingencyUsdCachedBest: number;
  };
}

export function buildEstimate(args: {
  generatedOn: string;
  caseCount: number;
  measurements: CaseMeasurement[];
  judge: { working: JudgeMeasurement; published: JudgeMeasurement };
  calibrationHoldouts?: number;
  latencyCases?: number;
  latencyRepetitions?: number;
}): SpendEstimate {
  const aggregates = aggregate(args.measurements);
  const uncached = aggregates.map(uncachedCell);
  const cached: Record<string, MatrixCellCost[]> = {};
  for (const h of CACHE_HIT_SCENARIOS) {
    cached[h.toFixed(2)] = aggregates.map((a) => cachedCell(a, h));
  }

  // One judged result per (case x model); the cache mode does not change the
  // generated draft, so cached/uncached cells share a judged result.
  const judgedResults = args.caseCount * MATRIX_MODELS.length;
  const judge = [
    judgeCost(args.judge.working, "working", judgedResults),
    judgeCost(args.judge.published, "published", judgedResults),
  ];
  const holdouts = args.calibrationHoldouts ?? 15;
  const calibration = [
    judgeCost(args.judge.working, "working", holdouts),
    judgeCost(args.judge.published, "published", holdouts),
  ];
  const latencyPass = latencyPassCost(
    aggregates,
    args.latencyCases ?? 12,
    args.latencyRepetitions ?? 3,
  );

  const sum = (rows: { totalUsd: number }[]) =>
    rows.reduce((a, r) => a + r.totalUsd, 0);

  const matrixUncachedUsd = sum(uncached);
  const matrixCachedBestUsd = sum(cached["0.98"]);
  const matrixCachedWorstUsd = sum(cached["0.30"]);
  const judgeUsd = sum(judge);
  const calibrationUsd = sum(calibration);
  const latencyUsd = latencyPass.totalUsd;

  // Headline: the matrix ships BOTH columns, so the run cost is uncached +
  // cached, not one or the other.
  const rawUsd =
    matrixUncachedUsd +
    matrixCachedWorstUsd +
    judgeUsd +
    calibrationUsd +
    latencyUsd;
  const rawUsdCachedBest =
    matrixUncachedUsd +
    matrixCachedBestUsd +
    judgeUsd +
    calibrationUsd +
    latencyUsd;

  return {
    generatedOn: args.generatedOn,
    pricingVerifiedOn: PRICING_VERIFIED_ON,
    caseCount: args.caseCount,
    aggregates,
    matrix: { uncached, cached },
    judge,
    calibration,
    latencyPass,
    totals: {
      matrixUncachedUsd,
      matrixCachedBestUsd,
      matrixCachedWorstUsd,
      judgeUsd,
      calibrationUsd,
      latencyUsd,
      rawUsd,
      rawUsdCachedBest,
      withContingencyUsd: rawUsd * CONTINGENCY,
      withContingencyUsdCachedBest: rawUsdCachedBest * CONTINGENCY,
    },
  };
}
