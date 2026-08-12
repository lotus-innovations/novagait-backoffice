// Judge-calibration worksheet (spec 09 §2: "15 hand-scored holdout cases,
// judge/human agreement published with the disagreement table").
//
// The scorer is a HUMAN. That is the whole point of the artifact: an
// agreement number between a judge model and a model-written "human" score
// would measure nothing. So this module only prepares the worksheet and the
// key; it never scores, and the agreement table is computed in a later pass
// once Abhinav's scores come back.
//
// Blinding rules, from the orchestrator's brief:
//   - no judge verdicts anywhere in the worksheet,
//   - no model identity beside any draft (the mapping lives in the key file,
//     which the scorer does not read),
//   - the rubric sits at the top, one line per criterion per draft.
//
// The scorer sees exactly what the judge sees (drafted action text plus the
// case's expected decision, per judge.ts buildJudgeRequest) so the two are
// scoring the same evidence.

import type { GoldenCase } from "../golden";
import { JUDGE_VERDICTS } from "../graders/judge";
import type { RunOutcome } from "../outcome";
import { P0_TAG } from "../thresholds";

export const HELD_OUT_TAG = "held-out";
export const CALIBRATION_SAMPLE_SIZE = 15;

/**
 * Approved selection rule (orchestrator, 2026-08-11): the 15 lowest-numbered
 * held-out cases that also carry p0. Deterministic and reproducible, so the
 * sample can be regenerated and audited without a stored list.
 */
export function selectCalibrationCases(
  cases: GoldenCase[],
  size: number = CALIBRATION_SAMPLE_SIZE,
): GoldenCase[] {
  return cases
    .filter(
      (entry) =>
        entry.tags.includes(HELD_OUT_TAG) && entry.tags.includes(P0_TAG),
    )
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, size);
}

export interface CalibrationDraft {
  label: string;
  case_id: string;
  model: string;
  lane: string;
  expected_decision: string;
  drafted_action_text: string;
}

export interface CalibrationKey {
  ticket: string;
  generated_on: string;
  selection_rule: string;
  drafts: CalibrationDraft[];
}

export interface BuildCalibrationInput {
  cases: GoldenCase[];
  /** Outcomes from ONE lane: calibration scores one draft per case. */
  outcomes: RunOutcome[];
  lane: string;
  model: string;
  generatedOn: string;
  size?: number;
}

export const SELECTION_RULE =
  `the ${CALIBRATION_SAMPLE_SIZE} lowest-numbered golden cases carrying both ` +
  `"${HELD_OUT_TAG}" and "${P0_TAG}"`;

export interface CalibrationArtifacts {
  worksheet: string;
  key: CalibrationKey;
  /** Cases selected but skipped because the run produced no draft text. */
  skipped: { case_id: string; reason: string }[];
}

const label = (index: number): string =>
  `D${String(index + 1).padStart(2, "0")}`;

export function buildCalibration(
  input: BuildCalibrationInput,
): CalibrationArtifacts {
  const selected = selectCalibrationCases(input.cases, input.size);
  const byCase = new Map(input.outcomes.map((o) => [o.case_id, o] as const));

  const drafts: CalibrationDraft[] = [];
  const skipped: { case_id: string; reason: string }[] = [];
  for (const goldenCase of selected) {
    const outcome = byCase.get(goldenCase.id);
    const text = outcome?.drafted_action_text ?? null;
    if (outcome === undefined) {
      skipped.push({ case_id: goldenCase.id, reason: "no run outcome" });
      continue;
    }
    if (text === null || text.trim() === "") {
      // The judge skips these too (judge.ts: "run produced no drafted action
      // text"), so a blank line on the worksheet would be scoring nothing.
      skipped.push({
        case_id: goldenCase.id,
        reason: "run produced no drafted action text",
      });
      continue;
    }
    drafts.push({
      label: label(drafts.length),
      case_id: goldenCase.id,
      model: input.model,
      lane: input.lane,
      expected_decision: goldenCase.expected.decision,
      drafted_action_text: text,
    });
  }

  return {
    worksheet: renderWorksheet(drafts, input.generatedOn, skipped),
    key: {
      ticket: "LOT-105",
      generated_on: input.generatedOn,
      selection_rule: SELECTION_RULE,
      drafts,
    },
    skipped,
  };
}

function renderWorksheet(
  drafts: CalibrationDraft[],
  generatedOn: string,
  skipped: { case_id: string; reason: string }[],
): string {
  const lines: string[] = [];
  lines.push("# Judge calibration worksheet (LOT-105)");
  lines.push("");
  lines.push(`Generated ${generatedOn}. ${drafts.length} drafts to score.`);
  lines.push("");
  lines.push(
    "You are scoring drafted accounts-payable actions written for a human",
    "approver. Each draft below is shown with the decision the case was",
    "expected to reach, which is the only case context the judge model also",
    "receives. Model identity is deliberately withheld, and no machine score",
    "appears anywhere in this file.",
  );
  lines.push("");
  lines.push("## Rubric");
  lines.push("");
  lines.push(
    "Score each criterion from 0.0 to 1.0, then give one overall verdict.",
  );
  lines.push("");
  lines.push(
    "| Criterion | 0.0 | 1.0 |",
    "| --- | --- | --- |",
    "| tone | unusable in front of an approver | reads like a competent colleague wrote it |",
    "| completeness | an approver still has to go find the facts | everything needed to approve or reject is present |",
    "| evidence | claims are asserted without support | every claim is supported by the draft's own evidence |",
  );
  lines.push("");
  lines.push(
    `Overall verdict is one of: ${JUDGE_VERDICTS.join(", ")}. Grade only tone,`,
    "completeness and evidence-support. Do not grade extraction accuracy,",
    "tool use, or whether the routing decision was correct: the judge cannot",
    "see those either, so scoring them would make the two incomparable.",
  );
  lines.push("");
  lines.push("## Drafts");
  lines.push("");

  for (const draft of drafts) {
    lines.push(`### ${draft.label}`);
    lines.push("");
    lines.push(`Expected decision: \`${draft.expected_decision}\``);
    lines.push("");
    lines.push("Drafted action:");
    lines.push("");
    lines.push("> " + draft.drafted_action_text.split("\n").join("\n> "));
    lines.push("");
    lines.push(`- ${draft.label} tone: `);
    lines.push(`- ${draft.label} completeness: `);
    lines.push(`- ${draft.label} evidence: `);
    lines.push(`- ${draft.label} verdict: `);
    lines.push(`- ${draft.label} note (optional): `);
    lines.push("");
  }

  if (skipped.length > 0) {
    lines.push("## Not scored");
    lines.push("");
    lines.push(
      "These selected cases produced no drafted action, so neither the judge",
      "nor a human has anything to score. They are excluded from agreement.",
    );
    lines.push("");
    for (const entry of skipped) {
      lines.push(`- ${entry.case_id}: ${entry.reason}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `Selection rule: ${SELECTION_RULE}.`,
    "Fill the values in place and hand the file back; the agreement table and",
    "disagreement list are computed from it in a follow-up pass.",
  );
  lines.push("");
  return lines.join("\n");
}
