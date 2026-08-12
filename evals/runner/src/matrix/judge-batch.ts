// Batched judge grading (spec 09 §2 layer 3, §4 "via Batch API").
//
// The judge is offline grading, not an interactive call, so it runs through
// the same Batch API as the matrix and takes the same 50% discount. Cache
// mode does not change what the generator produced, so one judged result per
// (case, model) covers both matrix columns.
//
// Layer 3 never touches pass/fail (judge.ts, spec 09 §2). This module only
// attaches verdicts to already-graded results.

import { resolveThinking } from "@novagait/agent";
import {
  JUDGE_OUTPUT_SCHEMA,
  buildJudgeRequest,
  validateJudgeVerdict,
  type JudgeResult,
} from "../graders/judge";
import type { GoldenCase } from "../golden";
import type { RunOutcome } from "../outcome";
import type { BatchClient, BatchRequest } from "./batch";
import type { SpendLedger } from "./ledger";

export const JUDGE_MAX_TOKENS = 1024;

/**
 * Structured outputs reject numerical constraints (`minimum`, `maximum`,
 * `multipleOf`), and the whole batch request errors if one is present. The
 * judge schema in graders/judge.ts bounds `score` to 0..1, which is correct
 * as published documentation and is exactly what the API refuses.
 *
 * So the constraint is stripped on the way to the wire and enforced where it
 * already was: validateJudgeVerdict rejects a score outside 0..1 before any
 * verdict is kept. The published schema stays as authored; only the request
 * copy is narrowed.
 *
 * Stripping alone is NOT enough, and this is the trap: with no bound in the
 * schema and no bound in the prompt, a judge reads "score" as 0-10 and returns
 * 7.5. validateJudgeVerdict then rejects every verdict and calibration comes
 * back empty with no error anywhere. The range therefore has to be carried in
 * language the model reads - a property description and an explicit
 * instruction - which is what SCORE_RANGE_NOTE and describeScore do.
 */
export const SCORE_RANGE_NOTE =
  "score is a number from 0.0 to 1.0 inclusive, where 1.0 is a flawless draft. " +
  "Do not use a 0-10 or percentage scale.";

export function apiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(apiSchema);
  if (schema === null || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([key]) => !["minimum", "maximum", "multipleOf"].includes(key))
      .map(([key, value]) => [key, apiSchema(value)]),
  );
}

/** Re-states the stripped bound where the model will actually read it. */
export function describeScore(schema: unknown): unknown {
  const root = apiSchema(schema) as Record<string, unknown>;
  const properties = root.properties as Record<string, unknown> | undefined;
  const score = properties?.score as Record<string, unknown> | undefined;
  if (score) score.description = SCORE_RANGE_NOTE;
  return root;
}

export interface JudgeTarget {
  case_id: string;
  model: string;
  lane: string;
  goldenCase: GoldenCase;
  outcome: RunOutcome;
}

export interface JudgeBatchOptions {
  client: BatchClient;
  ledger: SpendLedger;
  judgeModel: string;
  role: "working" | "published";
  targets: JudgeTarget[];
  worstCasePerRequestUsd: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface JudgeBatchResult {
  judgeModel: string;
  role: string;
  /** Keyed `${case_id}:${generator model}`. */
  verdicts: Map<string, JudgeResult>;
  cost_usd: number;
  batch_id: string | null;
  skipped: number;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Doubles as the batch `custom_id`, which the API validates against
 * ^[a-zA-Z0-9_-]{1,64}$ - a colon is rejected, so the separator is "__".
 * Both the request and the verdict lookup go through this function, so the
 * two cannot disagree.
 */
export const judgeKey = (caseId: string, model: string): string =>
  `${caseId}__${model}`;

function textOf(message: {
  content: { type: string; text?: string }[];
}): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

export async function runJudgeBatch(
  options: JudgeBatchOptions,
): Promise<JudgeBatchResult> {
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? wait;
  const verdicts = new Map<string, JudgeResult>();

  // A run with no drafted action has nothing to judge; judge.ts skips these
  // interactively and the batch must not spend a request on them either.
  const judgeable = options.targets.filter((target) => {
    const text = target.outcome.drafted_action_text;
    if (text === null || text.trim() === "") {
      verdicts.set(judgeKey(target.case_id, target.model), {
        model: options.judgeModel,
        verdict: null,
        skipped_reason: "run produced no drafted action text",
        errors: [],
      });
      return false;
    }
    return true;
  });

  if (judgeable.length === 0) {
    return {
      judgeModel: options.judgeModel,
      role: options.role,
      verdicts,
      cost_usd: 0,
      batch_id: null,
      skipped: options.targets.length,
    };
  }

  options.ledger.assertHeadroom(
    judgeable.length * options.worstCasePerRequestUsd,
    `judge ${options.role} (${judgeable.length} results)`,
  );

  const byCustomId = new Map<string, JudgeTarget>();
  const requests: BatchRequest[] = judgeable.map((target) => {
    const customId = judgeKey(target.case_id, target.model);
    byCustomId.set(customId, target);
    const request = buildJudgeRequest(
      target.goldenCase,
      target.outcome.drafted_action_text ?? "",
      options.judgeModel,
    );
    // Thinking disabled on the judge for the same reason as the matrix lanes
    // (Abhinav, 2026-08-11): this is structured grading against a fixed
    // rubric, not open-ended reasoning, and adaptive thinking is on by
    // default on opus-5, which measurably inflates output tokens and adds
    // variance to a number that gets published. resolveThinking drops the
    // parameter for models that do not accept it.
    const thinking = resolveThinking(options.judgeModel, { type: "disabled" });
    return {
      custom_id: customId,
      params: {
        model: options.judgeModel,
        max_tokens: JUDGE_MAX_TOKENS,
        ...(thinking ? { thinking } : {}),
        system: `${request.instructions} ${SCORE_RANGE_NOTE}`,
        output_config: {
          format: {
            type: "json_schema",
            schema: apiSchema(JUDGE_OUTPUT_SCHEMA),
          },
        },
        messages: [
          {
            role: "user",
            content: [
              `Expected decision: ${request.expected_decision}`,
              "",
              "Drafted action:",
              request.drafted_action_text,
            ].join("\n"),
          },
        ],
      },
    };
  });

  log(`judge ${options.role}: submitting ${requests.length} results`);
  const { id: batchId } = await options.client.create(requests);

  const startedAt = Date.now();
  for (;;) {
    const status = await options.client.retrieve(batchId);
    if (status.processing_status === "ended") break;
    if (Date.now() - startedAt > (options.maxWaitMs ?? 3_600_000)) {
      throw new Error(`judge batch ${batchId} did not end in time`);
    }
    await sleep(options.pollIntervalMs ?? 20_000);
  }

  let cost = 0;
  for await (const row of options.client.results(batchId)) {
    const target = byCustomId.get(row.custom_id);
    if (target === undefined) continue;
    const key = judgeKey(target.case_id, target.model);

    if (row.result.type !== "succeeded" || row.result.message === undefined) {
      verdicts.set(key, {
        model: options.judgeModel,
        verdict: null,
        skipped_reason: "judge batch request failed",
        errors: [row.result.error?.message ?? row.result.type],
      });
      continue;
    }

    const message = row.result.message;
    cost += await options.ledger.add({
      key: `${batchId}:${row.custom_id}`,
      lane: `judge:${options.role}`,
      model: options.judgeModel,
      channel: "batch",
      write_ttl: null,
      case_id: target.case_id,
      round: null,
      usage: {
        input_tokens: message.usage.input_tokens ?? 0,
        output_tokens: message.usage.output_tokens ?? 0,
        cache_creation_input_tokens:
          message.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
      },
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(textOf(message as never));
    } catch (error) {
      verdicts.set(key, {
        model: options.judgeModel,
        verdict: null,
        skipped_reason: "judge response was not JSON",
        errors: [String(error)],
      });
      continue;
    }

    const validation = validateJudgeVerdict(parsed);
    if (!validation.valid || validation.verdict === null) {
      verdicts.set(key, {
        model: options.judgeModel,
        verdict: null,
        skipped_reason: "judge response failed schema validation",
        errors: validation.errors,
      });
      continue;
    }

    // Same grounding rule as the interactive judge: an evidence quote the
    // draft does not contain is the judge's own invention, and a score built
    // on one would poison calibration.
    const text = target.outcome.drafted_action_text ?? "";
    const ungrounded = validation.verdict.evidence_quotes.filter(
      (quote) => !text.includes(quote),
    );
    verdicts.set(
      key,
      ungrounded.length > 0
        ? {
            model: options.judgeModel,
            verdict: null,
            skipped_reason: "evidence quotes not grounded in drafted action",
            errors: ungrounded.map(
              (quote) =>
                `evidence quote not found in drafted action: "${quote}"`,
            ),
          }
        : {
            model: options.judgeModel,
            verdict: validation.verdict,
            skipped_reason: null,
            errors: [],
          },
    );
  }

  return {
    judgeModel: options.judgeModel,
    role: options.role,
    verdicts,
    cost_usd: cost,
    batch_id: batchId,
    skipped: options.targets.length - judgeable.length,
  };
}
