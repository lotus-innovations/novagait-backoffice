// The committed replay baseline. The header is not decoration: the replay
// lane is EXPECTED to fail a known set of cases, because the deterministic
// mock pipeline cannot reproduce judgments that belong to the model path.
// Anything failing outside these lists is a regression, and the test in
// baseline.test.ts keeps the lists honest against what actually grades.

import { mkdir, writeFile } from "node:fs/promises";
import { CASSETTE_LANE, CASSETTE_PIPELINE } from "./cassette";
import { BASELINE_DIR, REPLAY_BASELINE_PATH } from "./paths";
import type { EvalSummary } from "../summary";
import type { ReplayBaseline } from "./replay";

export const DOCUMENTED_REFERENCE =
  "evals/CASE-PLAN.md, Build outcome deviation 7 (deterministic-lane blind spots)";

// CASE-PLAN deviation 7, verbatim set: partial-line billings (021/022/023/
// 035), field-level discrepancies (041/052), and the two pre-existing
// model-path cases (004 total in email prose, 014 vendor not resolvable by
// the parser's line scan).
export const DOCUMENTED_KNOWN_FAILING = [
  "INV-004",
  "INV-014",
  "INV-021",
  "INV-022",
  "INV-023",
  "INV-035",
  "INV-041",
  "INV-052",
];

export const UNDOCUMENTED_REFERENCE =
  "LOT-106 replay-lane recording report, 2026-08-10; every entry requires a mock-pipeline fix or a CASE-PLAN entry before the next re-baseline";

export const UNDOCUMENTED_NOTE =
  "Empty by design. The recorder's original 20 undocumented divergences were all resolved at the LOT-106 merge (2026-08-10): 15 route cases stopped forbidding the gated execute_action attempt (attempt-then-park is the designed flow), GR-SCOPE rejects now draft their disposition through a traced draft_action call (spec 07 §7), sentinel invoice dates raise the date-ambiguity minor exception, and a sentinel invoice number is a hard missing-field exception. Anything appearing here again is NEW drift: fix it or document it, never let it linger.";

export const UNDOCUMENTED_KNOWN_FAILING: Record<string, string[]> = {};

export function expectedFailingCaseIds(): string[] {
  return [
    ...new Set([
      ...DOCUMENTED_KNOWN_FAILING,
      ...Object.values(UNDOCUMENTED_KNOWN_FAILING).flat(),
    ]),
  ].sort();
}

export function buildBaseline(summary: EvalSummary): ReplayBaseline {
  return {
    lane: CASSETTE_LANE,
    pipeline: CASSETTE_PIPELINE,
    generated_by: "npm run -w @novagait/evals-runner cassettes:baseline",
    known_failing: {
      documented: {
        reference: DOCUMENTED_REFERENCE,
        case_ids: [...DOCUMENTED_KNOWN_FAILING],
      },
      undocumented: {
        reference: UNDOCUMENTED_REFERENCE,
        note: UNDOCUMENTED_NOTE,
        reasons: UNDOCUMENTED_KNOWN_FAILING,
      },
    },
    summary,
  };
}

export async function writeBaseline(
  summary: EvalSummary,
  path: string = REPLAY_BASELINE_PATH,
): Promise<void> {
  await mkdir(BASELINE_DIR, { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(buildBaseline(summary), null, 2)}\n`,
    "utf8",
  );
}
