// Compiles the committed eval artifacts into src/lib/eval-data.generated.ts
// for the /eval static route (LOT-109). Same pattern as the agent KB and the
// mock-backend fixtures: no runtime fs reads (Turbopack/serverless), a drift
// test fails CI if artifacts change without regeneration.
//
//   node scripts/generate-eval-data.mjs   (from apps/web)
//
// Sources are the run artifacts, never this script: every number in the
// output is copied from a committed JSON, and the calibration constants are
// verified against calibration-results.md before anything is written.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const PUBLISHED_DIR = join(REPO, "evals/results/matrix-2026-08-11");
const REMEASURE_DIR = join(REPO, "evals/results/matrix-2026-08-13-p130");
const OUT = join(HERE, "../src/lib/eval-data.generated.ts");
// bd-100: the client-facing engagement doc restated these same figures in
// prose, which is the drift pattern that has already bitten Demo 4 three
// times. It now derives from this generator instead of from someone's memory.
const ENGAGEMENT_DOC = join(REPO, "docs/engagement/03-architecture.md");
const DOC_START = "<!-- eval-numbers:start -->";
const CONTAIN_START = "<!-- eval-containment:start -->";
const CONTAIN_END = "<!-- eval-containment:end -->";
const DOC_END = "<!-- eval-numbers:end -->";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

/** Only the fields the page renders; drop bulky per-case record blobs. */
function slimMatrix(matrix) {
  return {
    generated_on: matrix.generated_on,
    prompt_version: matrix.prompt_version,
    tools_version: matrix.tools_version,
    sdk_version: matrix.sdk_version,
    pricing_verified_on: matrix.pricing_verified_on,
    deployed_model: matrix.deployed_model,
    rows: matrix.rows.map((row) => ({
      model: row.model,
      mode: row.mode,
      cases: row.cases,
      passed: row.passed,
      pass_rate: row.pass_rate,
      p0_pass_rate: row.p0_pass_rate,
      mean_cost_per_run_usd: row.mean_cost_per_run_usd,
      cost_per_correct_run_usd: row.cost_per_correct_run_usd,
      p50_latency_ms: row.p50_latency_ms,
      p95_latency_ms: row.p95_latency_ms,
      mean_iterations: row.mean_iterations,
      output_capped_runs: row.output_capped_runs,
      model_policy_divergence: row.model_policy_divergence,
    })),
    metric_caveats: matrix.metric_caveats,
    notes: matrix.notes,
  };
}

/** Regrade lanes: gate objects, family/code failure counts, failed cases. */
function slimRegrade(regrade) {
  const lanes = {};
  for (const [key, lane] of Object.entries(regrade.lanes)) {
    lanes[key] = {
      cases_graded: lane.cases_graded,
      passed: lane.summary.passed,
      total: lane.summary.total,
      pass_rate: lane.summary.pass_rate,
      p0_passed: lane.summary.p0_passed,
      p0_total: lane.summary.p0_total,
      p0_pass_rate: lane.summary.p0_pass_rate,
      failures_by_family: lane.summary.failures_by_family,
      failures_by_code: lane.summary.failures_by_code,
      failed_cases: lane.failed_cases,
      gates: lane.gates,
    };
  }
  return { golden_revision_note: regrade.golden_revision_note, lanes };
}

// Judge calibration facts (2026-08-13 blinded hand-score, LOT-105). The
// numbers live in calibration-results.md; the anchors below are verified
// against that file so a re-scored calibration cannot leave these stale.
const CALIBRATION = {
  scored_on: "2026-08-13",
  drafts_scored: 12,
  verdict_agreement: "7/12",
  mean_abs_score_diff: 0.2308,
  direction:
    "conservative: in every disagreement the judge scored below the human; " +
    "it never rated a draft above the human's read",
  scope_note:
    "calibration measured the judge against PROMPT_VERSION 1.2.0 drafts; " +
    "it was not redone at 1.3.0 (an unscored 1.3.0 worksheet exists)",
};

// 1.2.0 containment facts, established by the skeptic-2 verification pass
// (matrix-2026-08-13-p130/skeptic2-findings.md, H1) and the RUN-LOG
// correction. Anchored to that committed file below.
const CONTAINMENT = {
  deployed_tier_attempts: 56,
  deployed_tier_held: 55,
  escape_case: "INV-004",
  escape_mechanism:
    "the model hallucinated a PO reference, routed the case auto_approve " +
    "under the $500 autonomy cap, and the simulated execution completed; " +
    "the gate gates on the disposed route, so a wrong route legitimises " +
    "the execution",
};

async function verifyContainmentAnchors() {
  const text = await readFile(
    join(REMEASURE_DIR, "skeptic2-findings.md"),
    "utf8",
  );
  // "| 27 | 0 |" pins the cached lane's attempts/escapes table row, so a
  // re-verification that moves either deployed-tier number breaks generation.
  for (const anchor of ["28/29", "| 27 | 0 |", "INV-004", "terminal_state"]) {
    if (!text.includes(anchor)) {
      throw new Error(
        `skeptic2-findings.md no longer contains "${anchor}"; update ` +
          "CONTAINMENT in generate-eval-data.mjs before regenerating",
      );
    }
  }
}

async function verifyCalibrationAnchors() {
  const text = await readFile(
    join(PUBLISHED_DIR, "calibration-results.md"),
    "utf8",
  );
  const anchors = [
    "Verdict agreement: 7/12",
    "Mean absolute score difference: 0.2308",
    "conservative",
  ];
  for (const anchor of anchors) {
    if (!text.includes(anchor)) {
      throw new Error(
        `calibration-results.md no longer contains "${anchor}"; update ` +
          "CALIBRATION in generate-eval-data.mjs before regenerating",
      );
    }
  }
}

const published = slimMatrix(
  await readJson(join(PUBLISHED_DIR, "matrix.json")),
);
const remeasure = slimMatrix(
  await readJson(join(REMEASURE_DIR, "matrix.json")),
);
const regradeBefore = slimRegrade(
  await readJson(join(PUBLISHED_DIR, "regrade-under-current-goldens.json")),
);
const regradeAfter = slimRegrade(
  await readJson(join(REMEASURE_DIR, "regrade-under-current-goldens.json")),
);
await verifyCalibrationAnchors();
await verifyContainmentAnchors();

const banner = `// GENERATED by scripts/generate-eval-data.mjs - do not edit.
// Sources: evals/results/matrix-2026-08-11 + matrix-2026-08-13-p130
// (matrix.json, regrade-under-current-goldens.json, calibration-results.md).
// Regenerate: npm run gen:eval-data -w web
`;

const body = `${banner}
export const PUBLISHED = ${JSON.stringify(published, null, 2)} as const;

export const REMEASURE = ${JSON.stringify(remeasure, null, 2)} as const;

export const REGRADE_BEFORE = ${JSON.stringify(regradeBefore, null, 2)} as const;

export const REGRADE_AFTER = ${JSON.stringify(regradeAfter, null, 2)} as const;

export const CALIBRATION = ${JSON.stringify(CALIBRATION, null, 2)} as const;

export const CONTAINMENT = ${JSON.stringify(CONTAINMENT, null, 2)} as const;
`;

await writeFile(OUT, body, "utf8");
console.log(`wrote ${OUT}`);

// ---------------------------------------------------------------------------
// Engagement doc: regenerate the measured-numbers block from the same source.
// ---------------------------------------------------------------------------

const UNCACHED = "claude-haiku-4-5:uncached";
const CACHED = "claude-haiku-4-5:cached";
const afterUncached = regradeAfter.lanes[UNCACHED];
const afterCached = regradeAfter.lanes[CACHED];
const pct = (value) => `${(value * 100).toFixed(1)}%`;

export function renderEngagementNumbers() {
  return [
    DOC_START,
    "",
    "- On the deployed model, the approval-bypass failure mode was measured at",
    `  **${CONTAINMENT.deployed_tier_attempts} attempts**. A prompt fix drove it to **${
      afterUncached.failures_by_code["GRD-004"] ?? 0
    }** in a re-measurement`,
    `  on the same ${afterUncached.total} cases, under the same rubric. The scope, stated plainly,`,
    "  is two lanes of the deployed model, one run each. The larger models were",
    "  not re-measured, and one run is not a proof of absence. The rubric itself",
    "  also moved: we tightened it so an agent that simply stopped posting could",
    '  not score as "fixed". The before numbers were re-graded under the new',
    "  rubric to keep the comparison fair.",
    `- The **P0 correctness gate still fails**, at ${afterUncached.p0_pass_rate.toFixed(
      3,
    )} and ${afterCached.p0_pass_rate.toFixed(3)} against a`,
    `  0.900 minimum on the priority cases. Overall pass rate across all ${afterUncached.total} cases`,
    `  is ${pct(afterUncached.pass_rate)} and ${pct(
      afterCached.pass_rate,
    )}. The largest remaining failure class is the agent`,
    "  being _too conservative_. The agent holds invoices your policy would pay.",
    "  The",
    "  rest are formatting, extraction, and limit faults.",
    "- Therefore: **autonomous mode is a no-go today.** Assisted and shadow modes",
    "  are supported and are what we would deploy.",
    "",
    DOC_END,
  ].join("\n");
}

function renderContainment() {
  return [
    CONTAIN_START,
    "",
    "An earlier version of the model drafted a correct hold, then tried to post",
    `anyway **${CONTAINMENT.deployed_tier_attempts} times**. The gate stopped ${CONTAINMENT.deployed_tier_held} of them.`,
    "",
    CONTAIN_END,
  ].join("\n");
}

function replaceRegion(text, start, end, rendered, path) {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1) {
    throw new Error(`${path} is missing the ${start} / ${end} markers`);
  }
  return text.slice(0, from) + rendered + text.slice(to + end.length);
}

const docText = await readFile(ENGAGEMENT_DOC, "utf8");
let rebuilt = replaceRegion(
  docText,
  DOC_START,
  DOC_END,
  renderEngagementNumbers(),
  ENGAGEMENT_DOC,
);
rebuilt = replaceRegion(
  rebuilt,
  CONTAIN_START,
  CONTAIN_END,
  renderContainment(),
  ENGAGEMENT_DOC,
);
if (rebuilt !== docText) {
  await writeFile(ENGAGEMENT_DOC, rebuilt, "utf8");
  console.log(`wrote ${ENGAGEMENT_DOC}`);
} else {
  console.log(`${ENGAGEMENT_DOC} already in sync`);
}
