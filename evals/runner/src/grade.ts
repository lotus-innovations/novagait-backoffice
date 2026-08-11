// Grading orchestrator (spec 09 §2-3). Runs layer 1, then layer 2 with
// layer 1's results in hand (the fuzzy layer credits inexact-but-equivalent
// matches), then assigns exactly one primary taxonomy code by the precedence
// declared in evals/taxonomy.json. The judge is a separate, optional, async
// step: grade() stays synchronous and key-free so the replay lane can call it.

import type { GoldenCase } from "./golden";
import { gradeDeterministic } from "./graders/deterministic";
import { gradeFuzzy, type FuzzyOptions } from "./graders/fuzzy";
import {
  judgeDraftedAction,
  type JudgeOptions,
  type JudgeResult,
} from "./graders/judge";
import type { CheckResult } from "./graders/types";
import type { RunOutcome } from "./outcome";
import { rankCodes } from "./taxonomy";

export interface GradeTaxonomy {
  primary: string | null;
  secondaries: string[];
}

export interface GradeResult {
  case_id: string;
  tags: string[];
  pass: boolean;
  layers: {
    deterministic: CheckResult[];
    fuzzy: CheckResult[];
  };
  // Layer-1 check ids that failed but were credited by layer 2.
  credited: string[];
  // Every failing check that still counts, in precedence order.
  failed: CheckResult[];
  taxonomy: GradeTaxonomy;
  judge: JudgeResult | null;
}

export type GradeOptions = FuzzyOptions;

export function grade(
  goldenCase: GoldenCase,
  outcome: RunOutcome,
  options: GradeOptions = {},
): GradeResult {
  const deterministic = gradeDeterministic(goldenCase, outcome);
  const fuzzy = gradeFuzzy(goldenCase, outcome, deterministic, options);

  const credited = new Set(
    fuzzy.flatMap((check) =>
      check.status === "pass" ? (check.credits ?? []) : [],
    ),
  );

  const failed = [...deterministic, ...fuzzy].filter(
    (check) => check.status === "fail" && !credited.has(check.id),
  );

  const order = rankCodes(
    failed
      .map((check) => check.code)
      .filter((code): code is string => code !== null),
  );
  const orderedFailures = [...failed].sort(
    (a, b) => order.indexOf(a.code ?? "") - order.indexOf(b.code ?? ""),
  );

  return {
    case_id: goldenCase.id,
    tags: [...goldenCase.tags],
    pass: failed.length === 0,
    layers: { deterministic, fuzzy },
    credited: [...credited],
    failed: orderedFailures,
    taxonomy: { primary: order[0] ?? null, secondaries: order.slice(1) },
    judge: null,
  };
}

// Layer 3 attaches here and nowhere else: the judge's score is carried on
// the result for publication and calibration, and `pass` is already decided
// before it runs (spec 09 §2: pass/fail weight on layers 1-2 only).
export async function gradeWithJudge(
  goldenCase: GoldenCase,
  outcome: RunOutcome,
  options: GradeOptions & { judge: JudgeOptions },
): Promise<GradeResult> {
  const result = grade(goldenCase, outcome, options);
  const judge = await judgeDraftedAction(goldenCase, outcome, options.judge);
  return { ...result, judge };
}
