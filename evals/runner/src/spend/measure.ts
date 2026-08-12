// Token measurement against messages.count_tokens (FREE endpoint - see
// https://platform.claude.com/docs/en/build-with-claude/token-counting:
// "Token counting is free to use but subject to requests per minute rate
// limits based on your usage tier").
//
// S9 HARD RULE: this module must never call messages.create or any endpoint
// that consumes tokens. The only client method referenced is countTokens.

import Anthropic from "@anthropic-ai/sdk";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolName } from "@novagait/agent";
import { loadGoldenCases, type GoldenCase } from "../golden";
import {
  SYSTEM_PROMPT,
  TOOLS,
  buildCaseInputs,
  buildTurns,
  type CaseInputs,
} from "./payloads";

export const MATRIX_MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-opus-5",
] as const;
export type MatrixModel = (typeof MATRIX_MODELS)[number];

const CONCURRENCY = Number(process.env.SPEND_CONCURRENCY ?? 6);

function client(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.trim() === "") {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Source the runtime env file " +
        "(secrets/backoffice-runtime.env) before running the estimator. " +
        "Refusing to substitute guessed token counts.",
    );
  }
  return new Anthropic({ apiKey: key, maxRetries: 5 });
}

// Constructed on FIRST USE, not at module load. Importing this module (or
// anything that reaches it, e.g. cost.ts -> report.ts) must not require a
// key: the renderer is pure and belongs in the key-free CI lane, and until
// this was lazy it dragged a credential requirement into every importer.
// The key check itself is unchanged - it still fires, still with the same
// message, on the first call that would actually contact the API.
let apiSingleton: Anthropic | null = null;
function api(): Anthropic {
  if (apiSingleton === null) apiSingleton = client();
  return apiSingleton;
}

async function countTokens(
  model: string,
  messages: Anthropic.MessageParam[],
  opts: { system?: string; tools?: Anthropic.Tool[] } = {},
): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await api().messages.countTokens({
        model,
        messages,
        ...(opts.system ? { system: opts.system } : {}),
        ...(opts.tools ? { tools: opts.tools } : {}),
      });
      return res.input_tokens;
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

/**
 * The system+tools cacheable prefix, measured on its own.
 *
 * This is the span `cache_control` marks in loop.ts: render order is
 * tools -> system -> messages, so a breakpoint on the last system block
 * covers both. The one-character user turn is the smallest legal message
 * list; its handful of tokens sit outside the marked prefix, so the number
 * returned is a slight OVER-count of the prefix, which is the safe
 * direction when checking against a per-model cache minimum.
 */
export async function measurePrefixTokens(model: string): Promise<number> {
  return countTokens(model, [{ role: "user", content: "." }], {
    system: SYSTEM_PROMPT,
    tools: TOOLS,
  });
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })(),
  );
  await Promise.all(workers);
  return out;
}

export interface CassetteSummary {
  caseId: string;
  decision: string;
  draftedText: string;
  toolCalls: ToolName[];
}

export async function loadCassettes(
  dir: string,
): Promise<Map<string, CassetteSummary>> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const out = new Map<string, CassetteSummary>();
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(dir, file), "utf8"));
    out.set(raw.case_id, {
      caseId: raw.case_id,
      decision: raw.outcome.decision ?? "exception_hold",
      draftedText: raw.outcome.drafted_action_text ?? "",
      toolCalls: (raw.outcome.tool_calls ?? []) as ToolName[],
    });
  }
  return out;
}

export interface CaseMeasurement {
  caseId: string;
  model: MatrixModel;
  iterations: number;
  // Billed input = sum over iterations of the conversation length at that
  // iteration (the API re-reads the whole prefix every turn).
  inputTokensPerIteration: number[];
  totalInputTokens: number;
  outputTokensPerIteration: number[];
  totalOutputTokens: number;
  // The system+tools prefix shared by all 73 cases: the cacheable span.
  prefixTokens: number;
  // Per-iteration count of tokens that sit AFTER the cacheable prefix.
  suffixTokensPerIteration: number[];
  totalSuffixTokens: number;
}

const FINAL_TEXT_SAMPLE =
  "I routed this invoice for approval. The three-way match cleared on vendor and purchase order, the price variance sits inside tolerance, and the drafted action records the policy line the approver needs.";

export async function measureCase(
  model: MatrixModel,
  goldenCase: GoldenCase,
  cassette: CassetteSummary,
): Promise<CaseMeasurement> {
  const inputs: CaseInputs = await buildCaseInputs(
    goldenCase,
    cassette.toolCalls,
  );
  const turns = await buildTurns(
    inputs,
    cassette.decision,
    cassette.draftedText,
  );

  const prefixTokens = await countTokens(
    model,
    [{ role: "user", content: "." }],
    { system: SYSTEM_PROMPT, tools: TOOLS },
  );

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: inputs.userMessage },
  ];

  const inputTokensPerIteration: number[] = [];
  const outputTokensPerIteration: number[] = [];

  for (let i = 0; i <= turns.length; i++) {
    const cumulative = await countTokens(model, messages, {
      system: SYSTEM_PROMPT,
      tools: TOOLS,
    });
    inputTokensPerIteration.push(cumulative);

    // Output for this iteration = the delta from appending the assistant
    // turn. A trailing tool_use is rejected by the API without a following
    // tool_result, so a MINIMAL tool_result envelope is appended with it;
    // that envelope (~15 tok) biases the output estimate slightly HIGH,
    // which is the conservative direction for a budget. Recorded in the
    // workpaper as a stated approximation.
    const probe: Anthropic.MessageParam[] =
      i < turns.length
        ? [
            ...messages,
            turns[i].assistant,
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: `toolu_${goldenCase.id}_${i}`,
                  content: ".",
                },
              ],
            },
          ]
        : [...messages, { role: "assistant", content: FINAL_TEXT_SAMPLE }];
    const withAssistant = await countTokens(model, probe, {
      system: SYSTEM_PROMPT,
      tools: TOOLS,
    });
    outputTokensPerIteration.push(Math.max(0, withAssistant - cumulative));

    if (i < turns.length) {
      messages.push(turns[i].assistant, turns[i].toolResult);
    }
  }

  const suffixTokensPerIteration = inputTokensPerIteration.map((t) =>
    Math.max(0, t - prefixTokens),
  );

  return {
    caseId: goldenCase.id,
    model,
    iterations: inputTokensPerIteration.length,
    inputTokensPerIteration,
    totalInputTokens: inputTokensPerIteration.reduce((a, b) => a + b, 0),
    outputTokensPerIteration,
    totalOutputTokens: outputTokensPerIteration.reduce((a, b) => a + b, 0),
    prefixTokens,
    suffixTokensPerIteration,
    totalSuffixTokens: suffixTokensPerIteration.reduce((a, b) => a + b, 0),
  };
}

export interface JudgeMeasurement {
  model: string;
  meanInputTokens: number;
  meanOutputTokens: number;
  cases: number;
}

const JUDGE_INSTRUCTIONS_TEXT = [
  "You are grading ONE drafted accounts-payable action, written for a human approver.",
  "Grade only: tone, completeness, and whether every claim is supported by the draft's own evidence.",
  "Do not grade extraction accuracy, tool use, or policy routing: you cannot see them.",
  "Every evidence quote must be copied verbatim from the drafted action text.",
].join(" ");

const JUDGE_OUTPUT_SCHEMA_TEXT = JSON.stringify({
  type: "object",
  properties: {
    score: { type: "number", minimum: 0, maximum: 1 },
    verdict: { type: "string", enum: ["pass", "borderline", "fail"] },
    rationale: { type: "string" },
    evidence_quotes: { type: "array", items: { type: "string" } },
  },
  required: ["score", "verdict", "rationale", "evidence_quotes"],
  additionalProperties: false,
});

const JUDGE_VERDICT_SAMPLE = JSON.stringify({
  score: 0.86,
  verdict: "pass",
  rationale:
    "The draft states the route, names the policy line that produced it, and every factual claim about the invoice is carried by a quoted span in the draft itself. Tone is neutral and addressed to the approver. One completeness gap: the payment date is asserted without restating the terms it derives from.",
  evidence_quotes: [
    "full match under autonomy cap",
    "Approval Authority and Autonomy Limits",
  ],
});

export async function measureJudge(
  model: string,
  cassettes: CassetteSummary[],
): Promise<JudgeMeasurement> {
  const inputs = await mapLimit(cassettes, CONCURRENCY, async (c) => {
    const user = JSON.stringify({
      case_id: c.caseId,
      expected_decision: c.decision,
      drafted_action_text: c.draftedText,
      output_schema: JSON.parse(JUDGE_OUTPUT_SCHEMA_TEXT),
    });
    return countTokens(model, [{ role: "user", content: user }], {
      system: JUDGE_INSTRUCTIONS_TEXT,
    });
  });
  const base = await countTokens(model, [{ role: "user", content: "." }]);
  const withVerdict = await countTokens(model, [
    { role: "user", content: "." },
    { role: "assistant", content: JUDGE_VERDICT_SAMPLE },
  ]);
  return {
    model,
    meanInputTokens: inputs.reduce((a, b) => a + b, 0) / inputs.length,
    meanOutputTokens: Math.max(0, withVerdict - base),
    cases: inputs.length,
  };
}

export async function measureAll(goldenDir: string, cassetteDir: string) {
  const cases = await loadGoldenCases(goldenDir);
  const cassettes = await loadCassettes(cassetteDir);
  const pairs = cases
    .map((c) => ({ goldenCase: c, cassette: cassettes.get(c.id) }))
    .filter((p): p is { goldenCase: GoldenCase; cassette: CassetteSummary } =>
      Boolean(p.cassette),
    );

  const limit = Number(process.env.SPEND_LIMIT ?? pairs.length);
  const selected = pairs.slice(0, limit);

  const measurements: CaseMeasurement[] = [];
  for (const model of MATRIX_MODELS) {
    const perCase = await mapLimit(selected, CONCURRENCY, (p) =>
      measureCase(model, p.goldenCase, p.cassette),
    );
    measurements.push(...perCase);
    process.stdout.write(`measured ${model}: ${perCase.length} cases\n`);
  }

  const judgeWorking = await measureJudge(
    "claude-sonnet-5",
    selected.map((p) => p.cassette),
  );
  const judgePublished = await measureJudge(
    "claude-opus-5",
    selected.map((p) => p.cassette),
  );

  return {
    caseCount: selected.length,
    measurements,
    judge: { working: judgeWorking, published: judgePublished },
  };
}
