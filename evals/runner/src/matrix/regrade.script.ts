// Regrades a finished matrix directory's checkpointed outcomes under the
// CURRENT golden revision, at zero cost.
//
// Why this exists (CASE-PLAN amendment 13): lane numbers are only comparable
// when graded under the same golden revision. The 2026-08-11 lanes were
// graded before amendment 13 required the execute_action attempt on payable
// routes, so a before/after table against a 1.3.0 run must first regrade the
// "before" outcomes from their checkpoints - the outcomes themselves are
// paid-for and immutable; only the rubric moved.
//
// Key-free: reads checkpoints and goldens, writes one JSON artifact. Judge
// verdicts are NOT attached (layer 3 is reported, never gated, and the point
// here is gate/pass comparability).
//
//   MATRIX_CHECKPOINT_DIR=evals/results/matrix-2026-08-11 \
//     npm run -w @novagait/evals-runner matrix:regrade

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { loadGoldenCases } from "../golden";
import { LIVE_MATRIX_MODELS } from "../live-lane";
import type { RunOutcome } from "../outcome";
import { gradeLane, loadBaseline } from "./results";
import { MATRIX_MODES, laneKey, type LaneId, type MatrixMode } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const GOLDEN_DIR = join(REPO, "evals/golden");
const BASELINE_PATH = join(REPO, "evals/baseline/latest.json");
const CHECKPOINT_DIR = join(
  REPO,
  process.env.MATRIX_CHECKPOINT_DIR ?? "evals/results/matrix-2026-08-11",
);
const OUT_PATH = join(CHECKPOINT_DIR, "regrade-under-current-goldens.json");

/** checkpoint-<model>-<mode>.json -> LaneId; the mode is the last segment. */
function laneFromCheckpointName(name: string): LaneId | null {
  const match = /^checkpoint-(.+)-(uncached|cached)\.json$/.exec(name);
  if (match === null) return null;
  const mode = match[2] as MatrixMode;
  if (!MATRIX_MODES.includes(mode)) return null;
  const model = LIVE_MATRIX_MODELS.find((entry) => entry === match[1]);
  if (model === undefined) return null;
  return { model, mode };
}

test("regrade checkpoints under current goldens", async () => {
  const cases = await loadGoldenCases(GOLDEN_DIR);
  const baseline = await loadBaseline(BASELINE_PATH);
  const names = (await readdir(CHECKPOINT_DIR)).filter(
    (name) => laneFromCheckpointName(name) !== null,
  );
  expect(names.length).toBeGreaterThan(0);

  const lanes: Record<string, unknown> = {};
  for (const name of names.sort()) {
    const lane = laneFromCheckpointName(name)!;
    const checkpoint = JSON.parse(
      await readFile(join(CHECKPOINT_DIR, name), "utf8"),
    ) as { outcomes: RunOutcome[] };
    const graded = gradeLane({
      lane,
      cases,
      outcomes: checkpoint.outcomes,
      baseline,
    });
    lanes[laneKey(lane)] = {
      cases_graded: graded.results.length,
      summary: graded.summary,
      gates: graded.gates,
      failed_cases: graded.results
        .filter((entry) => !entry.pass)
        .map((entry) => ({
          case_id: entry.case_id,
          primary_code: entry.taxonomy.primary,
        })),
    };
    console.log(`${laneKey(lane)}: regraded ${graded.results.length} outcomes`);
  }

  const artifact = {
    generated_by: "matrix:regrade (LOT-129)",
    checkpoint_dir: CHECKPOINT_DIR.replace(`${REPO}/`, ""),
    golden_revision_note:
      "graded under the working tree's goldens (CASE-PLAN amendment 13: " +
      "payable routes require the execute_action attempt); judge verdicts " +
      "not attached",
    lanes,
  };
  await writeFile(OUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`wrote ${OUT_PATH}`);
});
