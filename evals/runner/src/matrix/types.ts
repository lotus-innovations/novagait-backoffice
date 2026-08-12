// The seam between the LOT-105 matrix driver and the live agent surface
// (LOT-120). The driver owns transport, batching, cost and grading; it owns
// none of the product's disposition logic, which is why this file describes a
// session it is handed rather than executors it builds.
//
// Every assumption behind these types is written down in ASSUMPTIONS.md.

import type { RunMode, Store, ToolExecutors } from "@novagait/agent";
import type { MockBackend } from "@novagait/mock-backend";
import type { GoldenCase } from "../golden";
import type { RunOutcome } from "../outcome";
import type { LiveMatrixModel } from "../live-lane";

export const MATRIX_MODES = ["uncached", "cached"] as const;
export type MatrixMode = (typeof MATRIX_MODES)[number];

/** One lane of the published matrix: a model crossed with a cache mode. */
export interface LaneId {
  model: LiveMatrixModel;
  mode: MatrixMode;
}

export const laneKey = (lane: LaneId): string => `${lane.model}:${lane.mode}`;

export interface OpenCaseOptions {
  /** Recorded on run.start; the matrix runs every lane autonomous. */
  mode: RunMode;
  /** Recorded on run.start so the trace names the model that actually ran. */
  model: string;
}

export interface RunTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface FinishArgs {
  totals: RunTotals;
  iterations: number;
  /**
   * Set only for a breaker terminal state the driver decided itself
   * (iteration cap, transport error). Left unset, the session settles the
   * business disposition, which is what a run that completed its turn gets.
   */
  terminal?: { outcome: string; failure_code: string | null };
}

/**
 * One golden case, opened for a live run.
 *
 * The driver holds this across batch rounds: it calls `start()`, sends
 * `userMessage` as the first user turn, calls `executors` between rounds as
 * the model requests tools, then `finish()` and `toOutcome()`.
 */
export interface LiveSession {
  runId: string;
  store: Store;
  /** The run's own backend, for tests that inspect what the run posted. */
  backend: MockBackend;
  executors: ToolExecutors;
  userMessage: string;
  /**
   * True when the pre-model guardrail screen already decided and traced the
   * run (GR-SCOPE reject). The model MUST NOT be called for such a case: the
   * driver excludes it from every round.
   */
  shortCircuit: boolean;
  /** Keeps trace node ids aligned with the round that produced the call. */
  setIteration(iteration: number): void;
  /** Writes run.start. No-op for a short-circuited run, which is already traced. */
  start(): Promise<void>;
  /** Settles the disposition (or records the driver's terminal state) and writes run.end. */
  finish(args: FinishArgs): Promise<void>;
  /**
   * Projection to the graded view, identical to cassettes/record.ts, so live
   * results and replay cassettes are graded by identical code.
   */
  toOutcome(): Promise<RunOutcome>;
}

export interface LivePipeline {
  openCase(
    goldenCase: GoldenCase,
    options: OpenCaseOptions,
  ): Promise<LiveSession>;
}
