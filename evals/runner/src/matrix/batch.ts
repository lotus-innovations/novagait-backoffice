// Round-based batch driver for the LOT-105 live matrix.
//
// The Batch API processes Messages requests; it does not run agentic loops.
// The agent loop is multi-turn (mean 6.84 model turns per case), so the lane
// is driven a TURN at a time rather than a case at a time:
//
//   round 0: one request per case          -> retrieve -> run the tools locally
//   round 1: one request per unfinished case -> retrieve -> run the tools
//   ... until every case terminates or the iteration cap is reached.
//
// Batching by turn rather than by case is what makes the cached column mean
// anything: all 73 requests in a round share the system+tools prefix, and the
// 1h TTL keeps the entry alive across rounds (a round trip can exceed the 5m
// window, which is exactly why the matrix uses the batch TTL).
//
// The driver owns transport, iteration accounting and cost. It owns none of
// the disposition logic: tools come from the LiveSession (LOT-120), and the
// graded view comes from session.toOutcome().

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  MAX_ITERATIONS,
  TOOL_NAMES,
  buildCachedSystem,
  buildSystemPrompt,
  resolveThinking,
  toolDescriptions,
  toolInputSchemas,
  type ToolName,
} from "@novagait/agent";
import type { GoldenCase } from "../golden";
import { MATRIX_THINKING } from "../live-lane";
import type { RunOutcome } from "../outcome";
import { CACHE_TTL_BATCH } from "@novagait/agent";
import { EMPTY_USAGE, type SpendLedger, type UsageTokens } from "./ledger";
import {
  laneKey,
  type LaneId,
  type LivePipeline,
  type LiveSession,
} from "./types";

export const DEFAULT_MAX_TOKENS = 2048;
export const DEFAULT_POLL_INTERVAL_MS = 20_000;

/**
 * Requests per submitted batch.
 *
 * Measured 2026-08-12: a 68-request sonnet-5 round sat in_progress for 72
 * minutes with ZERO completions, twice, while a 2-request sonnet-5 batch
 * submitted at the same moment completed in 1 minute. Sonnet batching was not
 * broken; large batches were not being scheduled. Splitting a round into
 * smaller batches keeps the round cadence under the 1h cache TTL, which is
 * what the cached column depends on to mean anything.
 */
export const DEFAULT_CHUNK_SIZE = 16;
// Measured 2026-08-12: haiku rounds settle in ~2 minutes, but a 68-request
// sonnet-5 round sat in_progress for 30+ minutes with zero completions. The
// docs allow up to 24h. An hour was tight enough to abort a paid run over a
// batch that was merely slow, so the ceiling is 4 hours and the real guard is
// the ledger, not the clock.
export const DEFAULT_MAX_WAIT_MS = 14_400_000;

/** Tool definitions exactly as the raw driver builds them (loop.ts rawDriver). */
export const MATRIX_TOOLS = TOOL_NAMES.map((name) => ({
  name,
  description: toolDescriptions[name],
  input_schema: z.toJSONSchema(toolInputSchemas[name]),
})) as unknown as Anthropic.Messages.Tool[];

export interface BatchRequest {
  custom_id: string;
  params: Record<string, unknown>;
}

export interface BatchResultRow {
  custom_id: string;
  result: {
    type: "succeeded" | "errored" | "canceled" | "expired";
    message?: Anthropic.Messages.Message;
    error?: { type?: string; message?: string };
  };
}

export interface BatchStatus {
  processing_status: string;
  request_counts?: Record<string, number>;
}

/**
 * The transport surface the driver needs. Narrow on purpose: the live run
 * binds it to client.messages.batches, and the tests bind it to a fake that
 * replays recorded tool sequences without touching the network.
 */
export interface BatchClient {
  create(requests: BatchRequest[]): Promise<{ id: string }>;
  retrieve(batchId: string): Promise<BatchStatus>;
  results(batchId: string): AsyncIterable<BatchResultRow>;
  cancel(batchId: string): Promise<void>;
}

/**
 * A batch with no completions after this long is treated as stuck, cancelled
 * and resubmitted.
 *
 * CORRECTED 2026-08-12, second time. `request_counts.succeeded` does NOT tick
 * up incrementally: a batch reports 0 succeeded for its whole run and then
 * jumps straight to its final counts. So "zero completions" never meant stuck,
 * and a 10-minute stall window cancelled batches that were about to finish -
 * observed repeatedly as `succeeded: 13, canceled: 3` on 16-request chunks,
 * which billed 13 requests whose results were then discarded, and made the
 * lane record no progress at all.
 *
 * Elapsed time is therefore the only usable signal, and the threshold has to
 * sit well above observed completion times (2 to 20 minutes) rather than in
 * the middle of them. Resubmission remains worth having: a batch genuinely
 * stuck for an hour did exist. It is just a rare-event backstop, not a
 * routine one.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 2_700_000;
export const DEFAULT_STALL_RETRIES = 3;

export function anthropicBatchClient(client: Anthropic): BatchClient {
  return {
    async cancel(batchId) {
      await client.messages.batches.cancel(batchId);
    },
    async create(requests) {
      const batch = await client.messages.batches.create({
        requests:
          requests as unknown as Anthropic.Messages.Batches.BatchCreateParams["requests"],
      });
      return { id: batch.id };
    },
    async retrieve(batchId) {
      const batch = await client.messages.batches.retrieve(batchId);
      return {
        processing_status: batch.processing_status,
        request_counts: batch.request_counts as unknown as Record<
          string,
          number
        >,
      };
    },
    // The SDK returns a Promise of a decoder, not a bare async iterable, so
    // the await has to happen inside the generator. Passing the promise
    // straight through fails at the for-await with a type error that only
    // shows up after a batch has already been paid for.
    async *results(batchId) {
      const stream = await client.messages.batches.results(batchId);
      for await (const row of stream) {
        yield row as unknown as BatchResultRow;
      }
    },
  };
}

interface CaseState {
  goldenCase: GoldenCase;
  session: LiveSession;
  messages: Anthropic.Messages.MessageParam[];
  iterations: number;
  done: boolean;
  shortCircuit: boolean;
  stopReason: string | null;
  transportError: string | null;
  iterationCapped: boolean;
  usage: UsageTokens;
  costUsd: number;
}

export interface CaseRunRecord {
  case_id: string;
  run_id: string;
  lane: string;
  model: string;
  mode: string;
  iterations: number;
  short_circuit: boolean;
  stop_reason: string | null;
  transport_error: string | null;
  iteration_capped: boolean;
  usage: UsageTokens;
  cost_usd: number;
}

export interface LaneRunResult {
  lane: LaneId;
  rounds: number;
  outcomes: RunOutcome[];
  records: CaseRunRecord[];
  cost_usd: number;
  batch_ids: string[];
}

export interface LaneRunOptions {
  lane: LaneId;
  cases: GoldenCase[];
  pipeline: LivePipeline;
  client: BatchClient;
  ledger: SpendLedger;
  /**
   * Measured upper bound for ONE COMPLETE CASE in this lane (all of its
   * model turns), used by the pre-submission hard-stop check. Derived from
   * the committed estimate's per-model aggregates, never guessed.
   *
   * Per case rather than per request on purpose: the estimate's per-model
   * total already sums every iteration, so multiplying a per-request figure
   * by the rounds remaining would double-count the loop and refuse lanes
   * that comfortably fit the envelope.
   */
  worstCasePerCaseUsd: number;
  maxRounds?: number;
  maxTokens?: number;
  /** Requests per submitted batch; see DEFAULT_CHUNK_SIZE. */
  chunkSize?: number;
  /** No completions within this window means stuck: cancel and resubmit. */
  stallTimeoutMs?: number;
  stallRetries?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function accumulate(
  target: UsageTokens,
  usage: Anthropic.Messages.Usage,
): void {
  target.input_tokens += usage.input_tokens ?? 0;
  target.output_tokens += usage.output_tokens ?? 0;
  target.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  target.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
}

/**
 * Executes one round's tool calls for a case and appends the turn.
 *
 * Mirrors rawDriver (loop.ts): the assistant message goes back verbatim, every
 * tool_use gets exactly one tool_result, and an executor throw becomes an
 * is_error result rather than killing the run, so the model can recover the
 * way it would in production.
 */
async function applyToolCalls(
  state: CaseState,
  message: Anthropic.Messages.Message,
): Promise<void> {
  state.messages.push({ role: "assistant", content: message.content });
  const results: Anthropic.Messages.ToolResultBlockParam[] = [];
  for (const block of message.content) {
    if (block.type !== "tool_use") continue;
    const name = block.name as ToolName;
    try {
      const input = toolInputSchemas[name].parse(block.input);
      const output = await state.session.executors[name](input as never);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    } catch (error) {
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: `tool error: ${String(error)}`,
        is_error: true,
      });
    }
  }
  state.messages.push({ role: "user", content: results });
}

interface PollOptions {
  pollIntervalMs: number;
  maxWaitMs: number;
  stallTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

/** Ends, or reports that the batch made no progress within the stall window. */
async function pollUntilEnded(
  client: BatchClient,
  batchId: string,
  options: PollOptions,
): Promise<"ended" | "stalled"> {
  const startedAt = Date.now();
  for (;;) {
    const status = await client.retrieve(batchId);
    if (status.processing_status === "ended") return "ended";
    const elapsed = Date.now() - startedAt;
    // Elapsed time only. Counts cannot be used: they stay at zero until the
    // batch ends, so any completion-based heuristic cancels healthy work.
    if (elapsed > options.stallTimeoutMs) return "stalled";
    if (elapsed > options.maxWaitMs) {
      throw new Error(
        `batch ${batchId} still ${status.processing_status} after ${options.maxWaitMs}ms`,
      );
    }
    options.log(
      `  ${batchId}: ${status.processing_status} ${JSON.stringify(status.request_counts ?? {})}`,
    );
    await options.sleep(options.pollIntervalMs);
  }
}

/**
 * Submits a chunk and sees it through to completion, resubmitting if the
 * batch gets stuck. Returns the id of the batch that actually ended, which is
 * the one whose results are read and whose ledger keys are used.
 */
async function submitUntilEnded(
  client: BatchClient,
  requests: BatchRequest[],
  options: PollOptions & { retries: number; label: string },
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const { id } = await client.create(requests);
    const verdict = await pollUntilEnded(client, id, options);
    if (verdict === "ended") return id;
    if (attempt >= options.retries) {
      throw new Error(
        `${options.label}: batch ${id} made no progress after ${options.retries + 1} attempts`,
      );
    }
    options.log(
      `  ${id}: no completions in ${Math.round(options.stallTimeoutMs / 60000)}min, cancelling and resubmitting`,
    );
    await client.cancel(id);
  }
}

/**
 * Runs one lane (a model crossed with a cache mode) to completion.
 *
 * Cost is recorded per result as it is read, keyed by batch id and case, so a
 * re-poll or a resumed lane cannot double-count. The hard-stop check runs
 * before every submission, never after.
 */
export async function runLane(options: LaneRunOptions): Promise<LaneRunResult> {
  const { lane, cases, pipeline, client, ledger, worstCasePerCaseUsd } =
    options;
  const maxRounds = options.maxRounds ?? MAX_ITERATIONS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const sleep = options.sleep ?? wait;
  const log = options.log ?? (() => {});
  const key = laneKey(lane);

  const systemText = buildSystemPrompt();
  // The cached lane carries the 1h breakpoint on the shared system+tools
  // prefix; the uncached lane sends the identical bytes with no cache_control,
  // so the two columns differ in caching alone.
  const system =
    lane.mode === "cached"
      ? buildCachedSystem(systemText, CACHE_TTL_BATCH)
      : systemText;
  const thinking = resolveThinking(lane.model, MATRIX_THINKING);

  const states: CaseState[] = [];
  for (const goldenCase of cases) {
    const session = await pipeline.openCase(goldenCase, {
      mode: "autonomous",
      model: lane.model,
    });
    // A GR-SCOPE reject is decided and fully traced before any model turn,
    // so the case is born done: it never enters a round and never costs a
    // request. Sending it anyway would bill for a decision already made.
    await session.start();
    states.push({
      goldenCase,
      session,
      messages: [{ role: "user", content: session.userMessage }],
      iterations: 0,
      done: session.shortCircuit,
      shortCircuit: session.shortCircuit,
      stopReason: session.shortCircuit ? "short_circuit" : null,
      transportError: null,
      iterationCapped: false,
      usage: { ...EMPTY_USAGE },
      costUsd: 0,
    });
  }

  const byId = new Map(states.map((state) => [state.goldenCase.id, state]));
  const batchIds: string[] = [];
  let laneCost = 0;
  let round = 0;

  for (; round < maxRounds; round++) {
    const active = states.filter((state) => !state.done);
    if (active.length === 0) break;

    // Cases already finished cannot spend again, so the bound shrinks with
    // the in-flight set rather than staying at the whole-lane figure.
    const worstCase = active.length * worstCasePerCaseUsd;
    ledger.assertHeadroom(
      worstCase,
      `${key} round ${round} (${active.length} cases)`,
    );

    const requests: BatchRequest[] = active.map((state) => ({
      custom_id: state.goldenCase.id,
      params: {
        model: lane.model,
        max_tokens: maxTokens,
        system,
        tools: MATRIX_TOOLS,
        messages: state.messages,
        ...(thinking ? { thinking } : {}),
      },
    }));

    // Submitted in chunks: one oversized batch can sit unscheduled for over
    // an hour, which both stalls the run and breaks the cached column's TTL
    // assumption. Chunks are submitted up front so they queue in parallel,
    // then drained in order.
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunks: BatchRequest[][] = [];
    for (let at = 0; at < requests.length; at += chunkSize) {
      chunks.push(requests.slice(at, at + chunkSize));
    }
    log(
      `${key} round ${round}: submitting ${requests.length} requests in ${chunks.length} batch(es)`,
    );
    const pollOptions = {
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      stallTimeoutMs: options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
      sleep,
      log,
    };

    const pending: CaseState[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const batchId = await submitUntilEnded(client, chunk, {
        ...pollOptions,
        retries: options.stallRetries ?? DEFAULT_STALL_RETRIES,
        label: `${key} round ${round} chunk ${index}`,
      });
      batchIds.push(batchId);
      for await (const row of client.results(batchId)) {
        const state = byId.get(row.custom_id);
        if (state === undefined) continue;

        if (
          row.result.type !== "succeeded" ||
          row.result.message === undefined
        ) {
          // A failed request ends the case rather than retrying it: a silent
          // retry would spend outside the pre-submission bound, and a case that
          // never produced a draft grades as the failure it was.
          state.transportError =
            row.result.error?.message ?? `batch result ${row.result.type}`;
          state.done = true;
          continue;
        }

        const message = row.result.message;
        accumulate(state.usage, message.usage);
        const cost = await ledger.add({
          key: `${batchId}:${row.custom_id}`,
          lane: key,
          model: lane.model,
          channel: "batch",
          write_ttl: lane.mode === "cached" ? CACHE_TTL_BATCH : null,
          case_id: row.custom_id,
          round,
          usage: {
            input_tokens: message.usage.input_tokens ?? 0,
            output_tokens: message.usage.output_tokens ?? 0,
            cache_creation_input_tokens:
              message.usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
          },
        });
        state.costUsd += cost;
        laneCost += cost;
        state.iterations += 1;
        state.stopReason = message.stop_reason ?? null;

        if (message.stop_reason === "tool_use") {
          pending.push(state);
          // Trace node ids must name the round that produced the call, or a
          // batched run's trace stops lining up with an interactive one.
          state.session.setIteration(round);
          await applyToolCalls(state, message);
        } else {
          state.done = true;
        }
      }
    }

    // A case the model wants to continue but that has no rounds left is
    // iteration-capped, the same terminal state runWorkflow records.
    if (round === maxRounds - 1) {
      for (const state of pending) {
        if (!state.done) {
          state.iterationCapped = true;
          state.done = true;
        }
      }
    }
  }

  const outcomes: RunOutcome[] = [];
  const records: CaseRunRecord[] = [];
  for (const state of states) {
    // Terminal state mirrors loop.ts: a breaker outcome is recorded as-is and
    // skips the business disposition, which only a completed turn reaches.
    const terminal = state.iterationCapped
      ? { outcome: "iteration_capped", failure_code: "SYS-003" }
      : state.transportError !== null
        ? { outcome: "error", failure_code: "SYS-002" }
        : undefined;
    await state.session.finish({
      totals: state.usage,
      iterations: state.iterations,
      terminal,
    });
    outcomes.push(await state.session.toOutcome());
    records.push({
      case_id: state.goldenCase.id,
      run_id: state.session.runId,
      lane: key,
      model: lane.model,
      mode: lane.mode,
      iterations: state.iterations,
      short_circuit: state.shortCircuit,
      stop_reason: state.stopReason,
      transport_error: state.transportError,
      iteration_capped: state.iterationCapped,
      usage: state.usage,
      cost_usd: state.costUsd,
    });
  }

  return {
    lane,
    rounds: round,
    outcomes,
    records,
    cost_usd: laneCost,
    batch_ids: batchIds,
  };
}
