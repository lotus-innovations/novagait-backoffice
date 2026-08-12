// Entrypoint: LOT-105 spend estimate (S9 gate).
//
//   set -a; . ~/dev/lotus/demos/secrets/backoffice-runtime.env; set +a
//   npx vitest run --config evals/runner/src/spend/vitest.scripts.config.ts
//
// Env knobs: SPEND_LIMIT (cases, default all), SPEND_CONCURRENCY (default 6),
// SPEND_OUT_DIR (default evals/).
//
// This script calls messages.count_tokens ONLY. It never calls
// messages.create. Zero live spend is a hard requirement of the S9 gate.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { MAX_ITERATIONS } from "@novagait/agent";
import { buildEstimate } from "./cost";
import { measureAll } from "./measure";
import { PROMPT_VERSION, TOOLS_VERSION } from "./payloads";
import { renderMarkdown } from "./report";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const GOLDEN_DIR = join(REPO_ROOT, "evals/golden");
const CASSETTE_DIR = join(REPO_ROOT, "evals/cassettes");
const STAMP = process.env.SPEND_STAMP ?? "2026-08-11";

test("estimate LOT-105 live matrix spend", async () => {
  const outDir = process.env.SPEND_OUT_DIR ?? join(REPO_ROOT, "evals");
  await mkdir(outDir, { recursive: true });

  const measured = await measureAll(GOLDEN_DIR, CASSETTE_DIR);

  // count_tokens calls: per model, per case, (iterations x 2) + 1 prefix;
  // plus judge (cases + 2) x 2 judge models.
  const countTokensCalls =
    measured.measurements.reduce((a, m) => a + m.iterations * 2 + 1, 0) +
    (measured.caseCount + 2) * 2;

  const estimate = buildEstimate({
    generatedOn: STAMP,
    caseCount: measured.caseCount,
    measurements: measured.measurements,
    judge: measured.judge,
  });

  // A recorded sequence of N tool calls needs N+1 model turns; anything past
  // MAX_ITERATIONS is truncated by the loop in a live run.
  const seen = new Set<string>();
  const casesOverCap = measured.measurements
    .filter((m) => m.iterations > MAX_ITERATIONS)
    .filter((m) => (seen.has(m.caseId) ? false : (seen.add(m.caseId), true)))
    .map((m) => ({ caseId: m.caseId, turns: m.iterations }))
    .sort((a, b) => a.caseId.localeCompare(b.caseId));

  const jsonPath = join(outDir, `spend-estimate-${STAMP}.json`);
  const mdPath = join(outDir, `spend-estimate-${STAMP}.md`);

  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        ...estimate,
        meta: {
          prompt_version: PROMPT_VERSION,
          tools_version: TOOLS_VERSION,
          count_tokens_calls: countTokensCalls,
          live_spend_usd: 0,
          iteration_cap: MAX_ITERATIONS,
          cases_over_iteration_cap: casesOverCap,
          per_case_measurements: measured.measurements,
          judge_measurements: measured.judge,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  await writeFile(
    mdPath,
    renderMarkdown(estimate, {
      promptVersion: PROMPT_VERSION,
      toolsVersion: TOOLS_VERSION,
      countTokensCalls,
      iterationCap: MAX_ITERATIONS,
      casesOverCap,
    }),
    "utf8",
  );

  console.info(
    [
      `cases: ${measured.caseCount}`,
      `count_tokens calls: ${countTokensCalls}`,
      `raw (best/worst): $${estimate.totals.rawUsdCachedBest.toFixed(2)} / $${estimate.totals.rawUsd.toFixed(2)}`,
      `with 1.3x: $${estimate.totals.withContingencyUsdCachedBest.toFixed(2)} / $${estimate.totals.withContingencyUsd.toFixed(2)}`,
      `-> ${mdPath}`,
      `-> ${jsonPath}`,
    ].join("\n"),
  );
});
