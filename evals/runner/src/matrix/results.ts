// Grading, gating and publication for the LOT-105 live matrix.
//
// Published columns are fixed by spec 09 §4: pass rate, mean cost per run,
// p50/p95 latency, cost per correct run. Everything here is derived from
// measured artifacts (graded outcomes, the spend ledger, the latency pass) so
// a published number can be traced to a file in the same directory.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MODEL } from "@novagait/agent";
import { grade, type GradeResult } from "../grade";
import type { GoldenCase } from "../golden";
import type { JudgeResult } from "../graders/judge";
import type { RunOutcome } from "../outcome";
import { summarize, type EvalSummary } from "../summary";
import { THRESHOLDS, evaluateGates, type GateEvaluation } from "../thresholds";
import type { CaseRunRecord } from "./batch";
import { judgeKey } from "./judge-batch";
import type { LedgerFile } from "./ledger";
import type { LatencyModelStats, LatencyPassResult } from "./latency";
import { laneKey, type LaneId } from "./types";

/** The tier the public demo runs (spec 13 preamble); the gates bind here. */
export const DEPLOYED_MODEL = DEFAULT_MODEL;

export interface LaneGrading {
  lane: LaneId;
  key: string;
  results: GradeResult[];
  summary: EvalSummary;
  gates: GateEvaluation;
  /** Only the deployed tier's gates block release (spec 09 §4). */
  blocking: boolean;
}

export function gradeLane(args: {
  lane: LaneId;
  cases: GoldenCase[];
  outcomes: RunOutcome[];
  judge?: Map<string, JudgeResult>;
  baseline?: EvalSummary | null;
}): LaneGrading {
  const byId = new Map(args.cases.map((entry) => [entry.id, entry] as const));
  const results: GradeResult[] = [];
  for (const outcome of args.outcomes) {
    const goldenCase = byId.get(outcome.case_id);
    if (goldenCase === undefined) continue;
    const graded = grade(goldenCase, outcome);
    const verdict = args.judge?.get(judgeKey(outcome.case_id, args.lane.model));
    results.push(verdict ? { ...graded, judge: verdict } : graded);
  }
  const key = laneKey(args.lane);
  const summary = summarize(results, { model: args.lane.model, lane: key });
  return {
    lane: args.lane,
    key,
    results,
    summary,
    gates: evaluateGates(summary, args.baseline ?? null),
    blocking: args.lane.model === DEPLOYED_MODEL,
  };
}

export interface MatrixRow {
  model: string;
  mode: string;
  cases: number;
  passed: number;
  pass_rate: number;
  p0_pass_rate: number;
  total_cost_usd: number;
  mean_cost_per_run_usd: number;
  cost_per_correct_run_usd: number | null;
  /** From the interactive pass; identical across a model's two mode rows. */
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  mean_iterations: number;
  /**
   * Cases where the model PROPOSED a route that policy then changed
   * (draft_action.args.model_route vs the disposed decision). Reported, never
   * graded: the disposed route is the product's answer. A high number here on
   * a passing lane is the interesting story, because it means the guardrails
   * are carrying the model.
   */
  model_policy_divergence: number | null;
  /**
   * Runs whose final turn ended on the output-token cap. A capped run cannot
   * finish its draft_action, so it grades as a failure that says nothing about
   * the model's judgement. Published on the ROW because a reader comparing
   * tiers is otherwise comparing one model against another model's truncation
   * rate: 27 of 73 opus runs died this way on 2026-08-12.
   */
  output_capped_runs: number;
}

/**
 * Model-proposed vs policy-disposed route for one lane.
 *
 * Returns null when NO case in the lane carries a captured proposal: that is
 * "this run cannot tell", and it must not be rendered as the zero that means
 * "the model always agreed with policy". The 2026-08-12 correction: the
 * proposal used to be read from a process-local map that only had entries for
 * cases run in THAT invocation, so every checkpoint-resumed lane published a
 * fabricated zero.
 */
export function laneDivergence(args: {
  lane: string;
  records: CaseRunRecord[];
  outcomes: RunOutcome[];
  /** Proposals for cases run in this process, when the record predates them. */
  fallback?: (runId: string) => string | null;
}): number | null {
  const decisions = new Map(
    args.outcomes.map(
      (outcome) => [outcome.case_id, outcome.decision] as const,
    ),
  );
  const proposals = args.records
    .filter((record) => record.lane === args.lane)
    .map((record) => ({
      case_id: record.case_id,
      proposed: record.model_route ?? args.fallback?.(record.run_id) ?? null,
    }))
    .filter((entry) => entry.proposed !== null);
  if (proposals.length === 0) return null;
  return proposals.filter(
    (entry) => entry.proposed !== decisions.get(entry.case_id),
  ).length;
}

export function buildMatrixRows(args: {
  gradings: LaneGrading[];
  records: CaseRunRecord[];
  latency: LatencyModelStats[];
  /** Per lane key; omit when the divergence column is not being published. */
  divergenceByLane?: Record<string, number | null>;
}): MatrixRow[] {
  const latencyByModel = new Map(
    args.latency.map((entry) => [entry.model, entry] as const),
  );
  return args.gradings.map((grading) => {
    const laneRecords = args.records.filter(
      (record) => record.lane === grading.key,
    );
    const totalCost = laneRecords.reduce((a, r) => a + r.cost_usd, 0);
    const runs = Math.max(1, laneRecords.length);
    const stats = latencyByModel.get(grading.lane.model) ?? null;
    const passed = grading.summary.passed;
    return {
      model: grading.lane.model,
      mode: grading.lane.mode,
      cases: grading.summary.total,
      passed,
      pass_rate: grading.summary.pass_rate,
      p0_pass_rate: grading.summary.p0_pass_rate,
      total_cost_usd: totalCost,
      mean_cost_per_run_usd: totalCost / runs,
      // Undefined rather than infinite when nothing passed: a cost-per-correct
      // figure with a zero denominator is not a number worth publishing.
      cost_per_correct_run_usd: passed === 0 ? null : totalCost / passed,
      p50_latency_ms: stats?.p50_ms ?? null,
      p95_latency_ms: stats?.p95_ms ?? null,
      mean_iterations: laneRecords.reduce((a, r) => a + r.iterations, 0) / runs,
      model_policy_divergence: args.divergenceByLane?.[grading.key] ?? null,
      output_capped_runs: laneRecords.filter(
        (record) => record.stop_reason === "max_tokens",
      ).length,
    };
  });
}

export interface MatrixArtifacts {
  ticket: string;
  generated_on: string;
  prompt_version: string;
  tools_version: string;
  sdk_version: string;
  pricing_verified_on: string;
  deployed_model: string;
  rows: MatrixRow[];
  lanes: {
    key: string;
    model: string;
    mode: string;
    blocking: boolean;
    summary: EvalSummary;
    gates: GateEvaluation;
  }[];
  latency: LatencyPassResult;
  ledger: LedgerFile;
  records: CaseRunRecord[];
  notes: string[];
  /**
   * Metrics the delta review found degenerate or easy to misread, copied from
   * evals/thresholds.json so a published number always travels with the
   * reason it might not mean what it looks like (spec 09 §5 wants the honest
   * verdict, which includes being honest about the measurements).
   */
  metric_caveats: Record<string, string>;
}

/** Optional block; absent on older thresholds files, so read defensively. */
export function metricCaveats(): Record<string, string> {
  const raw = (THRESHOLDS as unknown as Record<string, unknown>).metric_caveats;
  if (raw === null || typeof raw !== "object") return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function renderMatrixTable(rows: MatrixRow[]): string {
  const header = [
    "| model | mode | pass rate | P0 pass rate | mean $/run | $/correct run | p50 ms | p95 ms | model vs policy |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  const body = rows.map((row) =>
    [
      `| \`${row.model}\``,
      row.mode,
      `${(row.pass_rate * 100).toFixed(1)}%`,
      `${(row.p0_pass_rate * 100).toFixed(1)}%`,
      `$${row.mean_cost_per_run_usd.toFixed(4)}`,
      row.cost_per_correct_run_usd === null
        ? "n/a"
        : `$${row.cost_per_correct_run_usd.toFixed(4)}`,
      row.p50_latency_ms === null ? "n/a" : String(row.p50_latency_ms),
      row.p95_latency_ms === null ? "n/a" : String(row.p95_latency_ms),
      `${row.model_policy_divergence === null ? "n/a" : String(row.model_policy_divergence)} |`,
    ].join(" | "),
  );
  // Prominent, directly under the table, not in a footnote section a reader
  // reaches after they have already formed a view of the numbers above.
  const capped = rows
    .filter((row) => row.output_capped_runs > 0)
    .map(
      (row) =>
        `- **OUTPUT CAP, \`${row.model}\` ${row.mode}: ${row.output_capped_runs} of ` +
        `${row.cases} runs ended on the output-token cap.** A capped run is cut ` +
        "off mid-turn, and one cut off inside its `draft_action` reaches no " +
        "disposition at all, so it grades as a failure for running out of room " +
        "rather than for judgement. This row measures the model UNDER THAT CAP " +
        "and is not a clean capability comparison against a row that did not " +
        "truncate.",
    );
  return [
    ...header,
    ...body,
    ...(capped.length > 0 ? ["", ...capped] : []),
  ].join("\n");
}

export async function loadBaseline(path: string): Promise<EvalSummary | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      summary?: EvalSummary;
    } & Partial<EvalSummary>;
    return parsed.summary ?? (parsed as EvalSummary) ?? null;
  } catch {
    return null;
  }
}

export async function writeMatrixResults(
  dir: string,
  artifacts: MatrixArtifacts,
  perLaneResults: LaneGrading[],
  calibration?: { worksheet: string; key: unknown },
): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  const write = async (name: string, body: string): Promise<void> => {
    await writeFile(join(dir, name), body, "utf8");
    written.push(join(dir, name));
  };

  await write("matrix.json", `${JSON.stringify(artifacts, null, 2)}\n`);
  for (const lane of perLaneResults) {
    await write(
      `lane-${lane.key.replace(":", "-")}.json`,
      `${JSON.stringify({ summary: lane.summary, gates: lane.gates, results: lane.results }, null, 2)}\n`,
    );
  }
  await write(
    "latency.json",
    `${JSON.stringify(artifacts.latency, null, 2)}\n`,
  );

  if (calibration) {
    await write("calibration-worksheet.md", calibration.worksheet);
    await write(
      "calibration-key.json",
      `${JSON.stringify(calibration.key, null, 2)}\n`,
    );
  }

  const gateLines = perLaneResults.map((lane) => {
    const verdict = lane.gates.pass ? "PASS" : "FAIL";
    const scope = lane.blocking ? "blocking" : "informational";
    const detail = lane.gates.gates
      .map(
        (gate) =>
          `    - ${gate.id}: ${gate.pass ? "pass" : "FAIL"} (${gate.detail})`,
      )
      .join("\n");
    return `- \`${lane.key}\` ${verdict} (${scope})\n${detail}`;
  });

  await write(
    "README.md",
    [
      "# LOT-105 live model matrix",
      "",
      `Generated ${artifacts.generated_on}. Prompt ${artifacts.prompt_version}, tools ${artifacts.tools_version}, SDK ${artifacts.sdk_version}. Pricing verified ${artifacts.pricing_verified_on}.`,
      "",
      `Deployed tier: \`${artifacts.deployed_model}\`. Only that tier's gates block release (spec 09 §4); the other rows are published for comparison.`,
      "",
      "## Published matrix",
      "",
      renderMatrixTable(artifacts.rows),
      "",
      "Latency is measured on the interactive lane, uncached, and is therefore",
      "identical across a model's two cache rows (spec 13 §3).",
      "",
      '"model vs policy" counts cases where the model proposed one route and',
      "policy disposed another. It is reported, never graded: the disposed",
      "route is the product's answer, and this column says how often the",
      "guardrails did the deciding.",
      "",
      "## Gates",
      "",
      ...gateLines,
      "",
      ...(Object.keys(artifacts.metric_caveats).length > 0
        ? [
            "## Metric caveats",
            "",
            "Carried from `evals/thresholds.json`. These are measurement",
            "limits, not results: read them before quoting any number above.",
            "",
            ...Object.entries(artifacts.metric_caveats)
              .filter(([key]) => key !== "source")
              .map(([key, note]) => `- **${key}**: ${note}`),
            "",
          ]
        : []),
      "## Spend",
      "",
      `Actual: $${artifacts.ledger.totals.cost_usd.toFixed(2)} against a $${artifacts.ledger.envelope_hard_usd} envelope.`,
      "",
      ...artifacts.notes.map((note) => `- ${note}`),
      "",
    ].join("\n"),
  );

  return written;
}
