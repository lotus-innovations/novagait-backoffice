// Interactive latency pass (spec 09 §4, spec 13 §3: "latency measured
// separately on the interactive lane", "a separate small live pass").
//
// This lane deliberately does NOT batch. Batch latency is a queue metric and
// says nothing about what a buyer would feel clicking the demo, so the pass
// runs the real interactive loop (runWorkflow) and measures wall-clock per
// run. Sized at 12 cases x 3 models x 3 repetitions, as costed in the S9
// record; repetitions are what make p50/p95 meaningful.
//
// Two eval-only overrides, both via existing runWorkflow options rather than
// any product change:
//   - the per-run cost breaker is lifted, because an opus run costs ~$0.26
//     against a $0.03 production breaker and would abort as cost_capped
//     before producing a comparable latency figure;
//   - the wall clock is lifted for the same reason.
// Both are recorded in the results file so the published table cannot be read
// as if production containment were measured here.

import type Anthropic from "@anthropic-ai/sdk";
import { CACHE_TTL_INTERACTIVE, runWorkflow } from "@novagait/agent";
import type { GoldenCase } from "../golden";
import { MATRIX_THINKING, type LiveMatrixModel } from "../live-lane";
import type { RunOutcome } from "../outcome";
import { EMPTY_USAGE, type SpendLedger, type UsageTokens } from "./ledger";
import type { LivePipeline } from "./types";

export const LATENCY_CASES = 12;
export const LATENCY_REPETITIONS = 3;

/** Lifted far above the production breaker; see the header note. */
export const LATENCY_MAX_COST_MICRO_USD = 1_000_000;
export const LATENCY_WALL_CLOCK_MS = 600_000;

export interface LatencySample {
  case_id: string;
  model: string;
  repetition: number;
  latency_ms: number;
  iterations: number;
  outcome: string;
  usage: UsageTokens;
  cost_usd: number;
}

export interface LatencyModelStats {
  model: string;
  runs: number;
  p50_ms: number;
  p95_ms: number;
  mean_ms: number;
  min_ms: number;
  max_ms: number;
}

export interface LatencyPassResult {
  cases: string[];
  repetitions: number;
  samples: LatencySample[];
  stats: LatencyModelStats[];
  cost_usd: number;
  overrides: { max_cost_micro_usd: number; wall_clock_ms: number };
}

/**
 * Nearest-rank percentile on a sorted ascending sample.
 *
 * Nearest-rank rather than interpolation: with 36 runs per model an
 * interpolated p95 invents a number between two observed runs, and the honest
 * claim is "95% of observed runs finished at or under this observed time".
 */
export function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedMs.length);
  return sortedMs[Math.min(Math.max(rank, 1), sortedMs.length) - 1];
}

export function summarizeLatency(
  samples: LatencySample[],
): LatencyModelStats[] {
  const byModel = new Map<string, number[]>();
  for (const sample of samples) {
    const list = byModel.get(sample.model) ?? [];
    list.push(sample.latency_ms);
    byModel.set(sample.model, list);
  }
  return [...byModel.entries()].map(([model, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      model,
      runs: sorted.length,
      p50_ms: percentile(sorted, 50),
      p95_ms: percentile(sorted, 95),
      mean_ms: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      min_ms: sorted[0],
      max_ms: sorted[sorted.length - 1],
    };
  });
}

/**
 * Deterministic subset for the latency pass: the lowest-numbered P0 cases.
 *
 * P0 because those are the runs a buyer sees on the happy path and the ones
 * whose latency the demo is judged on; lowest-numbered so the subset is
 * reproducible without storing a list.
 */
export function selectLatencyCases(
  cases: GoldenCase[],
  size: number = LATENCY_CASES,
  p0Tag = "p0",
): GoldenCase[] {
  return cases
    .filter((entry) => entry.tags.includes(p0Tag))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, size);
}

export interface LatencyPassOptions {
  client: Anthropic;
  pipeline: LivePipeline;
  cases: GoldenCase[];
  models: readonly LiveMatrixModel[];
  ledger: SpendLedger;
  /** Measured upper bound for one interactive run, for the hard-stop check. */
  worstCasePerRunUsd: Record<string, number>;
  repetitions?: number;
  size?: number;
  log?: (message: string) => void;
}

export async function runLatencyPass(
  options: LatencyPassOptions,
): Promise<LatencyPassResult> {
  const repetitions = options.repetitions ?? LATENCY_REPETITIONS;
  const selected = selectLatencyCases(options.cases, options.size);
  const log = options.log ?? (() => {});
  const samples: LatencySample[] = [];
  let cost = 0;

  for (const model of options.models) {
    const worstCase = options.worstCasePerRunUsd[model] ?? 0;
    for (let repetition = 0; repetition < repetitions; repetition++) {
      for (const goldenCase of selected) {
        options.ledger.assertHeadroom(
          worstCase,
          `latency ${model} ${goldenCase.id} rep ${repetition}`,
        );
        const session = await options.pipeline.openCase(goldenCase, {
          mode: "autonomous",
          model,
        });
        const startedAt = Date.now();
        const result = await runWorkflow({
          client: options.client,
          store: session.store,
          mode: "autonomous",
          inputRef: goldenCase.input.fixture,
          userMessage: session.userMessage,
          executors: session.executors,
          model,
          runId: session.runId,
          // Interactive TTL on purpose: this lane measures the interactive
          // path, and the 5m write is what a real visitor's run would pay.
          cacheTtl: CACHE_TTL_INTERACTIVE,
          thinking: MATRIX_THINKING,
          maxCostMicroUsd: LATENCY_MAX_COST_MICRO_USD,
          wallClockMs: LATENCY_WALL_CLOCK_MS,
        });
        const latencyMs = Date.now() - startedAt;
        const usage: UsageTokens = {
          ...EMPTY_USAGE,
          input_tokens: result.totals.input_tokens,
          output_tokens: result.totals.output_tokens,
          cache_creation_input_tokens:
            result.totals.cache_creation_input_tokens,
          cache_read_input_tokens: result.totals.cache_read_input_tokens,
        };
        const spent = await options.ledger.add({
          key: `latency:${model}:${goldenCase.id}:${repetition}`,
          lane: `latency:${model}`,
          model,
          channel: "interactive",
          write_ttl: CACHE_TTL_INTERACTIVE,
          case_id: goldenCase.id,
          round: repetition,
          usage,
        });
        cost += spent;
        samples.push({
          case_id: goldenCase.id,
          model,
          repetition,
          latency_ms: latencyMs,
          iterations: result.iterations,
          outcome: result.outcome,
          usage,
          cost_usd: spent,
        });
        log(
          `latency ${model} ${goldenCase.id} rep ${repetition}: ${latencyMs}ms ${result.outcome}`,
        );
      }
    }
  }

  return {
    cases: selected.map((entry) => entry.id),
    repetitions,
    samples,
    stats: summarizeLatency(samples),
    cost_usd: cost,
    overrides: {
      max_cost_micro_usd: LATENCY_MAX_COST_MICRO_USD,
      wall_clock_ms: LATENCY_WALL_CLOCK_MS,
    },
  };
}

/** Unused outcomes are still returned so callers can grade the latency lane. */
export type LatencyOutcome = RunOutcome;
