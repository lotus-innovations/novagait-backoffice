// Agent loop (design brief A, arch doc A). One AgentStep contract, two
// interchangeable drivers:
//   - "runner": the SDK beta tool runner drives the loop (default)
//   - "raw":    a hand-written Messages-API loop, same trace, same tools
// The published eval report shows both drivers produce identical verdicts;
// the raw driver is also the insurance policy against beta-surface drift.
// No server-side tools, ever (spec: bounded cost, deterministic evals).

import Anthropic from "@anthropic-ai/sdk";
import { VERSION as SDK_VERSION } from "@anthropic-ai/sdk/version";
import { z } from "zod";
import {
  CACHE_TTL_INTERACTIVE,
  MAX_ITERATIONS,
  MAX_RUN_COST_MICRO_USD,
  RUN_WALL_CLOCK_MS,
  type CacheTtl,
} from "./policy-constants";
import { computeCostMicroUsd } from "./pricing";
import { PROMPT_VERSION, buildSystemPrompt } from "./prompts";
import type { Store } from "./store";
import {
  TOOLS_VERSION,
  TOOL_NAMES,
  buildTools,
  toolDescriptions,
  toolInputSchemas,
  type ToolExecutors,
  type ToolName,
} from "./tools";
import { nodeIds, type RunMode, type RunOutcome } from "./trace";
import type { Redactable } from "./redact";
import { TraceWriter } from "./trace-writer";

export const DEFAULT_MODEL = "claude-haiku-4-5";
export const DEFAULT_MAX_TOKENS = 2048;

export type DriverName = "runner" | "raw";

/**
 * Prompt caching (LOT-119).
 *
 * Render order is tools -> system -> messages, so ONE breakpoint on the last
 * system block covers the whole shared system+tools prefix. Both drivers
 * build the system block through this function so the cached bytes are
 * identical between them: the runner and the raw driver share a cache entry.
 *
 * The prefix must clear the model's minimum or cache_control is silently
 * ignored - no error, and cache_creation_input_tokens simply stays 0.
 * claude-haiku-4-5 (the production model) has the highest minimum of the
 * matrix at 4,096 tokens; the prefix measures 4,516 at prompt 1.2.0.
 * `npm run -w @novagait/evals-runner spend:prefix` re-measures it for free
 * and fails if any matrix model drops under its minimum - run it after any
 * edit to prompts.ts or the tool surface.
 */
export function buildCachedSystem(
  system: string,
  ttl: CacheTtl = CACHE_TTL_INTERACTIVE,
): Anthropic.Beta.BetaTextBlockParam[] {
  return [
    { type: "text", text: system, cache_control: { type: "ephemeral", ttl } },
  ];
}

/**
 * Models whose request surface accepts a `thinking` parameter at all.
 *
 * This is a strict capability allowlist covering EVERY thinking config, not
 * just `disabled`. claude-haiku-4-5 (the production model) predates the
 * parameter: `adaptive` is not part of its surface, and its extended-thinking
 * form is `{type: "enabled", budget_tokens: N}`, so forwarding any thinking
 * config to it risks a 400 on the one model the public demo actually runs.
 * An unknown model is treated as not supporting it: the param is dropped,
 * never forwarded on the assumption that it will be accepted.
 *
 * On opus-5, `disabled` is additionally rejected above `high` effort. The
 * loop sets no effort (so it runs at the default `high`), and there is no
 * effort knob to get this wrong with; if one is ever added, this guard is
 * where that interaction has to be re-checked.
 */
export const THINKING_CONFIG_SUPPORTED: readonly string[] = [
  "claude-sonnet-5",
  "claude-opus-5",
];

export function resolveThinking(
  model: string,
  thinking?: Anthropic.Beta.BetaThinkingConfigParam,
): Anthropic.Beta.BetaThinkingConfigParam | undefined {
  if (!thinking) return undefined;
  if (!THINKING_CONFIG_SUPPORTED.includes(model)) return undefined;
  return thinking;
}

/** See RunWorkflowOptions.traceArgs. */
export type TraceArgsProjector = (
  name: ToolName,
  input: Record<string, unknown>,
  output: string | undefined,
) => Record<string, Redactable>;

export interface AgentStep {
  message: Anthropic.Beta.BetaMessage;
  latencyMs: number;
}

interface DriverParams {
  client: Anthropic;
  model: string;
  maxTokens: number;
  system: Anthropic.Beta.BetaTextBlockParam[];
  messages: Anthropic.Beta.BetaMessageParam[];
  executors: ToolExecutors;
  maxIterations: number;
  thinking?: Anthropic.Beta.BetaThinkingConfigParam;
}

export type AgentDriver = (params: DriverParams) => AsyncGenerator<AgentStep>;

async function* runnerDriver(params: DriverParams): AsyncGenerator<AgentStep> {
  const thinking = resolveThinking(params.model, params.thinking);
  const runner = params.client.beta.messages.toolRunner({
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.system,
    tools: buildTools(params.executors),
    max_iterations: params.maxIterations,
    messages: params.messages,
    ...(thinking ? { thinking } : {}),
  });
  let started = Date.now();
  for await (const message of runner) {
    yield { message, latencyMs: Date.now() - started };
    started = Date.now();
  }
}

async function* rawDriver(params: DriverParams): AsyncGenerator<AgentStep> {
  const tools = TOOL_NAMES.map((name) => ({
    name,
    description: toolDescriptions[name],
    input_schema: z.toJSONSchema(
      toolInputSchemas[name],
    ) as Anthropic.Beta.BetaTool.InputSchema,
  }));
  const messages = [...params.messages];
  const thinking = resolveThinking(params.model, params.thinking);
  for (let iteration = 0; iteration < params.maxIterations; iteration++) {
    const started = Date.now();
    const message = await params.client.beta.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      tools,
      messages,
      ...(thinking ? { thinking } : {}),
    });
    yield { message, latencyMs: Date.now() - started };
    if (message.stop_reason !== "tool_use") return;

    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const name = block.name as ToolName;
      try {
        const input = toolInputSchemas[name].parse(block.input);
        const output = await params.executors[name](input as never);
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
    messages.push({ role: "user", content: results });
  }
}

const DRIVERS: Record<DriverName, AgentDriver> = {
  runner: runnerDriver,
  raw: rawDriver,
};

export function selectDriver(name?: string): DriverName {
  const candidate = name ?? process.env.AGENT_LOOP ?? "runner";
  return candidate === "raw" ? "raw" : "runner";
}

export interface RunWorkflowOptions {
  client: Anthropic;
  store: Store;
  mode: RunMode;
  inputRef: string;
  userMessage: string;
  executors: ToolExecutors;
  model?: string;
  maxTokens?: number;
  system?: string;
  runId?: string;
  driver?: DriverName;
  maxIterations?: number;
  /** Prompt-cache TTL for the system+tools prefix. Default 5m (interactive). */
  cacheTtl?: CacheTtl;
  /** Dropped for models that do not accept it (see resolveThinking). */
  thinking?: Anthropic.Beta.BetaThinkingConfigParam;
  maxCostMicroUsd?: number;
  wallClockMs?: number;
  /**
   * Trace writer to append to. Supply one when the caller writes its own
   * events for the same run (guardrail checks, memory reads, approval) so
   * both share a single monotonic `seq` and the caller's `mode` stamp; two
   * writers on one run id would each start at seq 0 and scramble the order.
   * Its runId wins over `runId` when both are given.
   */
  writer?: TraceWriter;
  /**
   * Project a tool call's arguments before they are traced. Defaults to
   * identity. The live pipeline uses it to keep `draft_action` args in the
   * shape the mock lane records ({route, summary}).
   *
   * `output` is the executor's own result, which is why it is a parameter
   * rather than something the projector reads out of a closure: the value a
   * projector needs is produced BY the call it is describing, so passing it
   * explicitly makes "project after executing" a property of the signature
   * instead of a rule in a comment that a second implementation can get
   * wrong. It is undefined when the executor threw.
   *
   * Redaction still applies afterwards, in the trace writer.
   */
  traceArgs?: TraceArgsProjector;
  // Business outcome comes from the caller (state machine / gate); the loop
  // only knows about breaker outcomes. Default is "held": safe, reviewable.
  // May be async: the live pipeline finalizes its disposition here, and the
  // outcome it returns is the one run.end records.
  resolveOutcome?: (
    finalText: string,
  ) =>
    | { outcome: RunOutcome; failure_code: string | null }
    | Promise<{ outcome: RunOutcome; failure_code: string | null }>;
}

export interface RunWorkflowResult {
  runId: string;
  driver: DriverName;
  outcome: RunOutcome;
  failureCode: string | null;
  finalText: string;
  iterations: number;
  totals: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  totalCostMicroUsd: number;
}

/**
 * Wrap executors so every tool call is traced identically wherever the loop
 * is driven from. runWorkflow uses this; so does any caller that drives the
 * executors itself (the eval matrix batches one model turn at a time and
 * cannot use runWorkflow). Exported so that path reuses this code instead of
 * mirroring it - a second copy drifts, and the trace is the graded record.
 */
export function traceToolExecutors(params: {
  writer: TraceWriter;
  executors: ToolExecutors;
  /** Current loop iteration, read at call time for the node id. */
  iteration: () => number;
  traceArgs?: TraceArgsProjector;
}): ToolExecutors {
  const attempts = new Map<string, number>();
  const projectArgs = (
    name: ToolName,
    input: unknown,
    output: string | undefined,
  ): Record<string, never> =>
    (params.traceArgs
      ? params.traceArgs(name, (input ?? {}) as Record<string, unknown>, output)
      : input) as Record<string, never>;

  return Object.fromEntries(
    TOOL_NAMES.map((name) => [
      name,
      async (input: never) => {
        const attempt = (attempts.get(name) ?? 0) + 1;
        attempts.set(name, attempt);
        const started = Date.now();
        try {
          const output = await params.executors[name](input);
          await params.writer.append({
            type: "tool.call",
            node_id: nodeIds.tool(params.iteration(), name),
            name,
            args: projectArgs(name, input, String(output)),
            result_summary: String(output).slice(0, 160),
            duration_ms: Date.now() - started,
            attempt,
          });
          return output;
        } catch (error) {
          await params.writer.append({
            type: "tool.call",
            node_id: nodeIds.tool(params.iteration(), name),
            name,
            args: projectArgs(name, input, undefined),
            result_summary: `error: ${String(error)}`.slice(0, 160),
            duration_ms: Date.now() - started,
            attempt,
          });
          throw error;
        }
      },
    ]),
  ) as unknown as ToolExecutors;
}

export async function runWorkflow(
  options: RunWorkflowOptions,
): Promise<RunWorkflowResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const driverName = selectDriver(options.driver);
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS;
  const maxCost = options.maxCostMicroUsd ?? MAX_RUN_COST_MICRO_USD;
  const wallClockMs = options.wallClockMs ?? RUN_WALL_CLOCK_MS;
  const system = options.system ?? buildSystemPrompt();
  // One resolved TTL for both the cache_control breakpoint and the cost
  // math: a 1h write bills 2.0x, not 1.25x (LOT-113), so the two must never
  // be resolved independently.
  const cacheTtl = options.cacheTtl ?? CACHE_TTL_INTERACTIVE;
  const cachedSystem = buildCachedSystem(system, cacheTtl);

  const writer =
    options.writer ?? new TraceWriter(options.store, options.runId);
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let totalCost = 0;
  let iterations = 0;
  let finalText = "";
  let outcome: RunOutcome | null = null;
  let failureCode: string | null = null;

  await writer.append({
    type: "run.start",
    node_id: nodeIds.run(),
    mode: options.mode,
    input_ref: options.inputRef,
    prompt_version: PROMPT_VERSION,
    tools_version: TOOLS_VERSION,
    model,
    sdk_version: SDK_VERSION,
  });

  // Wrap executors once so every driver traces tool calls identically.
  let currentIteration = 0;
  const tracedExecutors = traceToolExecutors({
    writer,
    executors: options.executors,
    iteration: () => currentIteration,
    traceArgs: options.traceArgs,
  });

  const runStarted = Date.now();
  const driver = DRIVERS[driverName]({
    client: options.client,
    model,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: cachedSystem,
    messages: [{ role: "user", content: options.userMessage }],
    executors: tracedExecutors,
    maxIterations,
    thinking: options.thinking,
  });

  try {
    for await (const step of driver) {
      currentIteration = iterations;
      await writer.append({
        type: "model.request",
        node_id: nodeIds.model(iterations),
        model,
        iteration: iterations,
        message_count: 1 + iterations * 2,
        est_input_tokens: totals.input_tokens,
      });
      const usage = {
        input_tokens: step.message.usage.input_tokens,
        output_tokens: step.message.usage.output_tokens,
        cache_creation_input_tokens:
          step.message.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens:
          step.message.usage.cache_read_input_tokens ?? 0,
      };
      const cost = computeCostMicroUsd(model, usage, cacheTtl);
      totals.input_tokens += usage.input_tokens;
      totals.output_tokens += usage.output_tokens;
      totals.cache_creation_input_tokens += usage.cache_creation_input_tokens;
      totals.cache_read_input_tokens += usage.cache_read_input_tokens;
      totalCost += cost;
      iterations += 1;
      await writer.append({
        type: "model.response",
        node_id: nodeIds.model(iterations - 1),
        model,
        stop_reason: step.message.stop_reason ?? "unknown",
        ...usage,
        cost_micro_usd: cost,
        latency_ms: step.latencyMs,
      });
      finalText = step.message.content
        .filter(
          (block): block is Anthropic.Beta.BetaTextBlock =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("");

      if (totalCost >= maxCost) {
        outcome = "cost_capped";
        failureCode = "SYS-003";
        break;
      }
      if (
        iterations >= maxIterations &&
        step.message.stop_reason === "tool_use"
      ) {
        outcome = "iteration_capped";
        failureCode = "SYS-003";
        break;
      }
      if (Date.now() - runStarted >= wallClockMs) {
        outcome = "iteration_capped";
        failureCode = "SYS-001";
        break;
      }
    }
  } catch (error) {
    outcome = "error";
    failureCode = "SYS-002";
    finalText = `run error: ${String(error)}`;
  }

  if (!outcome) {
    const resolved = (await options.resolveOutcome?.(finalText)) ?? {
      outcome: "held" as RunOutcome,
      failure_code: null,
    };
    outcome = resolved.outcome;
    failureCode = resolved.failure_code;
  }

  await writer.append({
    type: "run.end",
    node_id: nodeIds.run(),
    outcome,
    total_cost_micro_usd: totalCost,
    ...totals,
    iteration_count: iterations,
    failure_code: failureCode,
  });

  return {
    runId: writer.runId,
    driver: driverName,
    outcome,
    failureCode,
    finalText,
    iterations,
    totals,
    totalCostMicroUsd: totalCost,
  };
}
