// Layer 3, LLM-as-judge (spec 09 §2, arch doc B). Scaffold only: this module
// makes ZERO API calls and holds no client. The caller injects a JudgeClient,
// so the replay lane and every test run key-free.
//
// Two hard constraints from the spec:
//   1. The judge sees the drafted action text and the case's expected
//      decision, and nothing else. It cannot grade extraction or tool use,
//      which is precisely why its opinion is safe to publish.
//   2. The judge score NEVER contributes to pass/fail. Pass/fail weight sits
//      on layers 1-2; the judge is reported alongside and calibrated against
//      hand scores.

import { DEFAULT_MODEL, pricingFor } from "@novagait/agent";
import type { GoldenCase } from "../golden";
import type { RunOutcome } from "../outcome";

// Model ids are validated against the pricing table rather than typed as
// free strings: an id the cost math cannot price must never reach a run.
const priced = (model: string): string => pricingFor(model).model;

export const GENERATOR_MODEL = priced(DEFAULT_MODEL);
export const JUDGE_MODEL = priced("claude-sonnet-5");
export const PUBLISHED_JUDGE_MODEL = priced("claude-opus-5");

export const JUDGE_VERDICTS = ["pass", "borderline", "fail"] as const;
export type JudgeVerdictLabel = (typeof JUDGE_VERDICTS)[number];

export interface JudgeVerdict {
  score: number; // 0..1
  verdict: JudgeVerdictLabel;
  rationale: string;
  evidence_quotes: string[];
}

// Structured-output schema handed to the API as output_config.format. Kept
// as data (not a Zod object) because it is published on the report page.
export const JUDGE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number", minimum: 0, maximum: 1 },
    verdict: { type: "string", enum: [...JUDGE_VERDICTS] },
    rationale: { type: "string" },
    evidence_quotes: { type: "array", items: { type: "string" } },
  },
  required: ["score", "verdict", "rationale", "evidence_quotes"],
  additionalProperties: false,
} as const;

export const JUDGE_INSTRUCTIONS = [
  "You are grading ONE drafted accounts-payable action, written for a human approver.",
  "Grade only: tone, completeness, and whether every claim is supported by the draft's own evidence.",
  "Do not grade extraction accuracy, tool use, or policy routing: you cannot see them.",
  "Every evidence quote must be copied verbatim from the drafted action text.",
].join(" ");

export interface JudgeRequest {
  model: string;
  case_id: string;
  // The ONLY case context the judge receives.
  expected_decision: string;
  drafted_action_text: string;
  instructions: string;
  output_schema: typeof JUDGE_OUTPUT_SCHEMA;
}

export interface JudgeClient {
  evaluate(request: JudgeRequest): Promise<unknown>;
}

export interface JudgeResult {
  model: string;
  verdict: JudgeVerdict | null;
  // Populated when the case was not judged, or the response was malformed.
  skipped_reason: string | null;
  errors: string[];
}

export function buildJudgeRequest(
  goldenCase: GoldenCase,
  draftedActionText: string,
  model: string = JUDGE_MODEL,
): JudgeRequest {
  return {
    model,
    case_id: goldenCase.id,
    expected_decision: goldenCase.expected.decision,
    drafted_action_text: draftedActionText,
    instructions: JUDGE_INSTRUCTIONS,
    output_schema: JUDGE_OUTPUT_SCHEMA,
  };
}

export function validateJudgeVerdict(candidate: unknown): {
  valid: boolean;
  errors: string[];
  verdict: JudgeVerdict | null;
} {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    return {
      valid: false,
      errors: ["judge response is not an object"],
      verdict: null,
    };
  }
  const response = candidate as Record<string, unknown>;
  if (typeof response.score !== "number" || Number.isNaN(response.score)) {
    errors.push("score must be a number");
  } else if (response.score < 0 || response.score > 1) {
    errors.push(`score must be within 0..1, got ${response.score}`);
  }
  if (!JUDGE_VERDICTS.includes(response.verdict as JudgeVerdictLabel)) {
    errors.push(`verdict must be one of ${JUDGE_VERDICTS.join("|")}`);
  }
  if (
    typeof response.rationale !== "string" ||
    response.rationale.trim() === ""
  ) {
    errors.push("rationale must be a non-empty string");
  }
  if (
    !Array.isArray(response.evidence_quotes) ||
    !response.evidence_quotes.every((quote) => typeof quote === "string")
  ) {
    errors.push("evidence_quotes must be a string array");
  }
  if (errors.length > 0) return { valid: false, errors, verdict: null };
  return { valid: true, errors, verdict: candidate as JudgeVerdict };
}

export interface JudgeOptions {
  client: JudgeClient;
  model?: string;
  // Reject quotes the draft does not contain. On by default: an unsupported
  // quote is the judge's own hallucination and would poison calibration.
  requireGroundedQuotes?: boolean;
}

export async function judgeDraftedAction(
  goldenCase: GoldenCase,
  outcome: RunOutcome,
  options: JudgeOptions,
): Promise<JudgeResult> {
  const model = options.model ?? JUDGE_MODEL;
  const text = outcome.drafted_action_text;
  if (text === null || text.trim() === "") {
    return {
      model,
      verdict: null,
      skipped_reason: "run produced no drafted action text",
      errors: [],
    };
  }

  const request = buildJudgeRequest(goldenCase, text, model);
  let response: unknown;
  try {
    response = await options.client.evaluate(request);
  } catch (error) {
    return {
      model,
      verdict: null,
      skipped_reason: "judge client error",
      errors: [String(error)],
    };
  }

  const validation = validateJudgeVerdict(response);
  if (!validation.valid || validation.verdict === null) {
    return {
      model,
      verdict: null,
      skipped_reason: "judge response failed schema validation",
      errors: validation.errors,
    };
  }

  if (options.requireGroundedQuotes !== false) {
    const ungrounded = validation.verdict.evidence_quotes.filter(
      (quote) => !text.includes(quote),
    );
    if (ungrounded.length > 0) {
      return {
        model,
        verdict: validation.verdict,
        skipped_reason: null,
        errors: ungrounded.map(
          (quote) => `evidence quote not found in drafted action: "${quote}"`,
        ),
      };
    }
  }

  return {
    model,
    verdict: validation.verdict,
    skipped_reason: null,
    errors: [],
  };
}
