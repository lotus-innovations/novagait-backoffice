// LOT-105 live matrix entrypoint.
//
// Sequenced cheapest-first (haiku, then sonnet, then opus, then judge, then
// the interactive latency pass) so a ledger-math or driver bug surfaces at
// haiku scale, where it costs about a dollar, rather than on opus. Partial
// results survive an abort: every lane writes its own artifact and the ledger
// is written through on every result.
//
// Runs only via its own vitest config, never under `npm test`, so a normal
// test run cannot reach the API:
//   npm run -w @novagait/evals-runner matrix:run

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { VERSION as SDK_VERSION } from "@anthropic-ai/sdk/version";
import { PROMPT_VERSION, TOOLS_VERSION } from "@novagait/agent";
import { expect, test } from "vitest";
import { loadGoldenCases } from "../golden";
import { JUDGE_MODEL, PUBLISHED_JUDGE_MODEL } from "../graders/judge";
import { LIVE_MATRIX_MODELS } from "../live-lane";
import type { RunOutcome } from "../outcome";
import { CONTINGENCY, PRICING_VERIFIED_ON } from "../spend/cost";
import {
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_STALL_RETRIES,
  DEFAULT_STALL_TIMEOUT_MS,
  anthropicBatchClient,
  runLane,
  type CaseRunRecord,
} from "./batch";
import { buildCalibration } from "./calibration";
import { runJudgeBatch, type JudgeTarget } from "./judge-batch";
import { runLatencyPass } from "./latency";
import { SpendLedger } from "./ledger";
import { createMatrixPipeline } from "./live-pipeline";
import {
  DEPLOYED_MODEL,
  buildMatrixRows,
  gradeLane,
  metricCaveats,
  loadBaseline,
  writeMatrixResults,
  type LaneGrading,
} from "./results";
import { MATRIX_MODES, laneKey, type LaneId } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const GOLDEN_DIR = join(REPO, "evals/golden");
const RESULTS_DIR = join(REPO, "evals/results/matrix-2026-08-11");
const LEDGER_PATH = join(REPO, "evals/results/spend-ledger-2026-08-11.json");
const ESTIMATE_PATH = join(
  REPO,
  "evals/spend-estimate-2026-08-11-post-lot119.json",
);
const BASELINE_PATH = join(REPO, "evals/baseline/latest.json");
const RUN_DATE = "2026-08-11";

/**
 * Smoke controls. This script spends real money and had never run end to end,
 * so the first invocation is a deliberately tiny one: same code path, same
 * ledger (smoke spend is real spend and counts against the envelope), a
 * separate results directory so it cannot be mistaken for the published run.
 */
const SMOKE = process.env.MATRIX_SMOKE === "1";
const CASE_LIMIT = Number(process.env.MATRIX_CASE_LIMIT ?? "0");
const LANE_FILTER = process.env.MATRIX_LANES ?? "";
const SKIP_LATENCY = process.env.MATRIX_SKIP_LATENCY === "1";
/**
 * Judge and latency are skippable so the expensive lanes can be driven in
 * separate invocations without re-paying for the cheap stages each time. A
 * lane-only pass sets both; the final pass sets neither and resumes every
 * completed lane from its checkpoint at zero cost.
 */
const SKIP_JUDGE = process.env.MATRIX_SKIP_JUDGE === "1";
/**
 * Stall handling, overridable per invocation.
 *
 * Measured 2026-08-12: haiku and opus batches end in 2-3 minutes, but
 * sonnet-5 batches of the same shape took 2.5 and 6 HOURS to end - and ended
 * with all 16 requests succeeded. The 45-minute default therefore cancelled
 * healthy sonnet work four times per lane and failed both sonnet lanes, which
 * is the same class of mistake as the completion-count heuristic it replaced:
 * a threshold set inside the range of normal completion times. Per-model
 * cadence is not knowable in advance, so it is an input rather than a
 * constant, and the ledger stays the real guard.
 */
const numberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, got ${raw}`);
  }
  return parsed;
};
const RESULTS_TARGET = SMOKE ? `${RESULTS_DIR}-smoke` : RESULTS_DIR;

/** Worst case for one complete case, per model, from the committed estimate. */
async function worstCasePerCase(): Promise<Record<string, number>> {
  const estimate = JSON.parse(await readFile(ESTIMATE_PATH, "utf8")) as {
    matrix: { uncached: { model: string; costPerRunUsd: number }[] };
  };
  const bounds: Record<string, number> = {};
  for (const cell of estimate.matrix.uncached) {
    // Uncached is the expensive column, and the contingency covers live tool
    // paths taking more turns than the cassettes recorded (assumption A1).
    bounds[cell.model] = cell.costPerRunUsd * CONTINGENCY;
  }
  return bounds;
}

test("LOT-105 live matrix", async () => {
  const log = (message: string): void => console.log(message);
  const client = new Anthropic();
  const batchClient = anthropicBatchClient(client);
  const ledger = await SpendLedger.open(LEDGER_PATH);
  const allCases = await loadGoldenCases(GOLDEN_DIR);
  const cases = CASE_LIMIT > 0 ? allCases.slice(0, CASE_LIMIT) : allCases;
  // Pre-seed resolution needs the WHOLE set even when the run is limited.
  const byId = new Map(allCases.map((entry) => [entry.id, entry] as const));
  const { pipeline, modelRoutes } = createMatrixPipeline({ goldenById: byId });
  const bounds = await worstCasePerCase();
  const baseline = await loadBaseline(BASELINE_PATH);
  const notes: string[] = [];

  // Cheapest model first, and within a model the uncached column first: the
  // uncached lane has no cache-write premium to waste if the lane aborts.
  const lanes: LaneId[] = [];
  for (const model of LIVE_MATRIX_MODELS) {
    for (const mode of MATRIX_MODES) lanes.push({ model, mode });
  }
  const selectedLanes =
    LANE_FILTER === ""
      ? lanes
      : lanes.filter((lane) => LANE_FILTER.split(",").includes(laneKey(lane)));
  log(
    `lanes: ${selectedLanes.map(laneKey).join(", ")} over ${cases.length} cases` +
      (SMOKE ? " [SMOKE]" : ""),
  );

  const records: CaseRunRecord[] = [];
  const outcomesByLane = new Map<string, RunOutcome[]>();

  // Per-lane checkpoints. A lane costs real money and up to an hour of wall
  // clock; without this, one slow batch late in the run discards every lane
  // already paid for. Written the moment a lane completes, and reloaded on a
  // later invocation so a resumed run skips what it already has.
  const checkpointPath = (lane: LaneId) =>
    join(RESULTS_TARGET, `checkpoint-${laneKey(lane).replace(":", "-")}.json`);

  for (const lane of selectedLanes) {
    const existing = await readFile(checkpointPath(lane), "utf8").then(
      (raw) =>
        JSON.parse(raw) as { outcomes: RunOutcome[]; records: CaseRunRecord[] },
      () => null,
    );
    if (existing !== null) {
      log(
        `${laneKey(lane)}: resumed from checkpoint (${existing.records.length} cases)`,
      );
      records.push(...existing.records);
      outcomesByLane.set(laneKey(lane), existing.outcomes);
      continue;
    }

    let result;
    try {
      result = await runLane({
        lane,
        cases,
        pipeline,
        client: batchClient,
        ledger,
        worstCasePerCaseUsd: bounds[lane.model] ?? 0,
        stallTimeoutMs: numberEnv(
          "MATRIX_STALL_TIMEOUT_MS",
          DEFAULT_STALL_TIMEOUT_MS,
        ),
        stallRetries: numberEnv("MATRIX_STALL_RETRIES", DEFAULT_STALL_RETRIES),
        maxWaitMs: numberEnv("MATRIX_MAX_WAIT_MS", DEFAULT_MAX_WAIT_MS),
        log,
      });
    } catch (error) {
      // A lane failure (batch timeout, transport) must not discard the lanes
      // already paid for. Record it, keep the completed lanes, carry on.
      notes.push(
        `LANE ${laneKey(lane)} FAILED (${String(error).slice(0, 200)}). It is ` +
          "absent from this matrix; completed lanes are unaffected.",
      );
      log(`${laneKey(lane)} failed: ${String(error)}`);
      continue;
    }
    records.push(...result.records);
    outcomesByLane.set(laneKey(lane), result.outcomes);
    await mkdir(RESULTS_TARGET, { recursive: true });
    await writeFile(
      checkpointPath(lane),
      `${JSON.stringify({ outcomes: result.outcomes, records: result.records }, null, 2)}\n`,
      "utf8",
    );
    log(
      `${laneKey(lane)} done in ${result.rounds} rounds, ` +
        `$${result.cost_usd.toFixed(4)}; ledger $${ledger.spentUsd.toFixed(2)}`,
    );

    if (ledger.shouldPause) {
      notes.push(
        `PAUSED after ${laneKey(lane)}: ledger crossed the ` +
          `$${ledger.spentUsd.toFixed(2)} soft line before the remaining lanes ran`,
      );
      break;
    }
  }

  // One judged result per (case, model): cache mode does not change what the
  // generator produced, so the uncached lane's drafts stand for both columns.
  const judgeTargets: JudgeTarget[] = [];
  for (const model of LIVE_MATRIX_MODELS) {
    const key = laneKey({ model, mode: "uncached" });
    for (const outcome of outcomesByLane.get(key) ?? []) {
      const goldenCase = byId.get(outcome.case_id);
      if (goldenCase === undefined) continue;
      judgeTargets.push({
        case_id: outcome.case_id,
        model,
        lane: key,
        goldenCase,
        outcome,
      });
    }
  }

  // Judge and latency are wrapped because the matrix lanes are the expensive
  // part: an hour of lane spend must not be thrown away by a failure in a
  // later, cheaper stage. A failed judge costs verdicts, not results.
  const judgeSafely = async (
    role: "working" | "published",
    model: string,
    bound: number,
  ) => {
    try {
      return await runJudgeBatch({
        client: batchClient,
        ledger,
        judgeModel: model,
        role,
        targets: judgeTargets,
        worstCasePerRequestUsd: bound,
        log,
      });
    } catch (error) {
      notes.push(
        `JUDGE ${role} FAILED (${String(error).slice(0, 200)}). Matrix results ` +
          "are unaffected; judge scores and calibration are absent from this run.",
      );
      log(`judge ${role} failed: ${String(error)}`);
      return null;
    }
  };

  const working = SKIP_JUDGE
    ? null
    : await judgeSafely("working", JUDGE_MODEL, 0.01);
  const publishedJudge = SKIP_JUDGE
    ? null
    : await judgeSafely("published", PUBLISHED_JUDGE_MODEL, 0.02);
  log(
    `judge: working $${(working?.cost_usd ?? 0).toFixed(4)}, ` +
      `published $${(publishedJudge?.cost_usd ?? 0).toFixed(4)}`,
  );

  // Graded once, with the published judge's verdicts attached. Layer 3 is
  // reported and never gated, so attaching it cannot move pass/fail.
  const gradings: LaneGrading[] = [];
  for (const lane of selectedLanes) {
    const outcomes = outcomesByLane.get(laneKey(lane));
    if (outcomes === undefined) continue;
    gradings.push(
      gradeLane({
        lane,
        cases,
        outcomes,
        judge: publishedJudge?.verdicts,
        baseline,
      }),
    );
  }

  // Model-proposed vs policy-disposed route, per lane. Free data: traceArgs
  // already keeps model_route on draft_action, so this is a join, not a run.
  const divergenceByLane: Record<string, number> = {};
  for (const [key, outcomes] of outcomesByLane) {
    const decisions = new Map(
      outcomes.map((outcome) => [outcome.case_id, outcome.decision] as const),
    );
    divergenceByLane[key] = records.filter((record) => {
      if (record.lane !== key) return false;
      const proposed = modelRoutes.get(record.run_id);
      if (proposed === undefined || proposed === null) return false;
      return proposed !== decisions.get(record.case_id);
    }).length;
  }

  const emptyLatency = {
    cases: [] as string[],
    repetitions: 0,
    samples: [],
    stats: [],
    cost_usd: 0,
    overrides: { max_cost_micro_usd: 0, wall_clock_ms: 0 },
  };
  const latency = SKIP_LATENCY
    ? {
        cases: [],
        repetitions: 0,
        samples: [],
        stats: [],
        cost_usd: 0,
        overrides: {
          max_cost_micro_usd: 0,
          wall_clock_ms: 0,
        },
      }
    : await runLatencyPass({
        client,
        pipeline,
        cases,
        models: LIVE_MATRIX_MODELS,
        ledger,
        worstCasePerRunUsd: bounds,
        log,
      }).catch((error: unknown) => {
        notes.push(
          `LATENCY PASS FAILED (${String(error).slice(0, 200)}). Matrix and ` +
            "judge results are unaffected; p50/p95 are absent from this run.",
        );
        log(`latency pass failed: ${String(error)}`);
        return emptyLatency;
      });

  // Calibration scores the deployed tier's drafts: the demo's own output is
  // what a buyer would read, so that is the text worth agreeing about.
  const deployedOutcomes =
    outcomesByLane.get(laneKey({ model: DEPLOYED_MODEL, mode: "uncached" })) ??
    [];
  const calibration =
    deployedOutcomes.length > 0
      ? buildCalibration({
          cases,
          outcomes: deployedOutcomes,
          lane: laneKey({ model: DEPLOYED_MODEL, mode: "uncached" }),
          model: DEPLOYED_MODEL,
          generatedOn: RUN_DATE,
        })
      : undefined;

  notes.push(
    // Counted, not asserted: the selection rule can yield fewer drafts than it
    // targets when a lane is missing, and a hardcoded count in a published
    // note is a template number masquerading as a measurement.
    `Calibration agreement is NOT in this directory. The ${calibration?.key.drafts.length ?? 0} draft(s) in ` +
      "calibration-worksheet.md are scored by a human (Abhinav); the agreement " +
      "and disagreement tables are computed in a follow-up pass from those scores.",
  );
  // Only describe the overrides when the pass actually ran. The skipped-latency
  // placeholder carries zeroes, and rendering it unconditionally published the
  // sentence "breaker lifted to $0.00 and wall clock to 0s" - a measurement
  // claim about a lane that never executed.
  notes.push(
    latency.samples.length > 0
      ? `Latency overrides: per-run breaker lifted to $${(latency.overrides.max_cost_micro_usd / 1_000_000).toFixed(2)} ` +
          `and wall clock to ${latency.overrides.wall_clock_ms / 1000}s, so an opus run is measured rather than cost-capped. ` +
          "Production containment is unchanged and is NOT what this lane measures."
      : "LATENCY PASS DID NOT RUN in this invocation, so p50/p95 are absent " +
          "and latency.json is empty. No latency claim in this directory is a measurement.",
  );

  if (SMOKE) {
    notes.push(
      "SMOKE RUN. A deliberately tiny subset used to prove the pipeline end to " +
        "end before the published run. Not the matrix; do not cite these numbers.",
    );
  }
  // Short-circuit savings, counted rather than asserted: a GR-SCOPE reject is
  // decided before any model turn and never costs a request.
  const shortCircuited = new Set(
    records.filter((record) => record.short_circuit).map((r) => r.case_id),
  ).size;
  if (records.length > 0) {
    notes.push(
      `Short-circuit savings: ${shortCircuited} of ${cases.length} golden cases are rejected by ` +
        "the pre-model GR-SCOPE screen and never cost a request, so every round " +
        `batches ${cases.length - shortCircuited}, not ${cases.length}.`,
    );
  }

  // The single most expensive lesson of this run, kept with the artifacts it
  // explains rather than in a thread nobody will read.
  notes.push(
    "Batch progress is NOT observable from request_counts: a batch reports zero " +
      "completions for its whole life and then jumps to final counts, so any " +
      "completion-based stall heuristic cancels healthy work. Stall handling is " +
      "elapsed-time only. Measured 2026-08-12: haiku and opus batches of 16 " +
      "requests ended in 2-3 minutes, while two sonnet-5 batches of the same " +
      "shape took 2.5 and 6 HOURS and ended with all 16 requests succeeded - " +
      "per-model batch cadence differs by two orders of magnitude and cannot be " +
      "assumed from another model's behaviour.",
  );

  if (baseline === undefined || baseline === null) {
    notes.push(
      "NO MOCK BASELINE WAS LOADED (evals/baseline/latest.json absent), so the " +
        "regression gates (p0_no_regression, aggregate_no_drop) had nothing to " +
        "compare against and PASSED VACUOUSLY. Do not read those two gates as " +
        "evidence of no regression; only the gates that evaluated real data " +
        "(p0_pass_rate, guardrail_hard_zero) carry a verdict.",
    );
  }

  notes.push(
    "Run history, incidents and the reasons lanes are missing are in " +
      "RUN-LOG.md in this directory. Read it before quoting any number here.",
  );

  notes.push(
    "Reviewer N3: a live model that resolves MORE vendors than the mock planner " +
      "emits extra lookup_vendor and memory.read events. That is correct " +
      "behaviour, not a defect: grading fails only on MISSING required calls or " +
      "must_not_call violations, so a higher tool count is not a penalty and " +
      "should not be read as noise.",
  );

  const written = await writeMatrixResults(
    RESULTS_TARGET,
    {
      ticket: "LOT-105",
      generated_on: RUN_DATE,
      prompt_version: PROMPT_VERSION,
      tools_version: TOOLS_VERSION,
      sdk_version: SDK_VERSION,
      pricing_verified_on: PRICING_VERIFIED_ON,
      deployed_model: DEPLOYED_MODEL,
      rows: buildMatrixRows({
        gradings,
        records,
        latency: latency.stats,
        divergenceByLane,
      }),
      lanes: gradings.map((grading) => ({
        key: grading.key,
        model: grading.lane.model,
        mode: grading.lane.mode,
        blocking: grading.blocking,
        summary: grading.summary,
        gates: grading.gates,
      })),
      latency,
      ledger: ledger.snapshot(),
      records,
      notes,
      metric_caveats: metricCaveats(),
    },
    gradings,
    calibration
      ? { worksheet: calibration.worksheet, key: calibration.key }
      : undefined,
  );

  log(`wrote ${written.length} artifacts to ${RESULTS_TARGET}`);
  log(`TOTAL SPEND $${ledger.spentUsd.toFixed(2)} of $65`);
  expect(ledger.spentUsd).toBeLessThanOrEqual(65);
});
