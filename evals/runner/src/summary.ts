// Run summary: the tool-agnostic shape the /eval page and the gates both
// read (arch doc B: keep the output schema swappable). One entry per graded
// case plus the aggregates the release gates need.

import type { GradeResult } from "./grade";
import { familyOf } from "./taxonomy";
import { P0_TAG } from "./thresholds";

export interface CaseSummary {
  case_id: string;
  tags: string[];
  pass: boolean;
  primary_code: string | null;
  secondary_codes: string[];
  // Layer 3, reported never gated (spec 09 §2).
  judge_score: number | null;
}

export interface EvalSummary {
  model: string;
  lane: string;
  total: number;
  passed: number;
  pass_rate: number;
  p0_total: number;
  p0_passed: number;
  p0_pass_rate: number;
  failures_by_family: Record<string, number>;
  failures_by_code: Record<string, number>;
  // Failing cases carrying a GRD code ANYWHERE (primary or secondary). The
  // hard-zero gate reads this, not failures_by_family, so a guardrail miss
  // cannot hide behind a SYS/FMT primary (review finding, 2026-08-10).
  guardrail_failures: number;
  cases: CaseSummary[];
}

export interface SummaryMeta {
  model: string;
  lane: string;
  p0Tag?: string;
}

const rate = (passed: number, total: number): number =>
  total === 0 ? 0 : passed / total;

export function summarize(
  results: GradeResult[],
  meta: SummaryMeta,
): EvalSummary {
  const p0Tag = meta.p0Tag ?? P0_TAG;
  const cases: CaseSummary[] = results.map((result) => ({
    case_id: result.case_id,
    tags: [...result.tags],
    pass: result.pass,
    primary_code: result.taxonomy.primary,
    secondary_codes: [...result.taxonomy.secondaries],
    judge_score: result.judge?.verdict?.score ?? null,
  }));

  const p0 = cases.filter((entry) => entry.tags.includes(p0Tag));
  const failuresByFamily: Record<string, number> = {};
  const failuresByCode: Record<string, number> = {};
  let guardrailFailures = 0;
  // Only the primary code is counted in the by-family/by-code charts: the
  // taxonomy chart totals must equal the failing-case count (spec 09 §3),
  // which secondaries would break. guardrail_failures is the exception:
  // it scans secondaries too, because taxonomy precedence puts SYS above
  // GRD and the hard-zero gate must still see a demoted guardrail miss.
  for (const entry of cases) {
    if (entry.pass || entry.primary_code === null) continue;
    failuresByCode[entry.primary_code] =
      (failuresByCode[entry.primary_code] ?? 0) + 1;
    const family = familyOf(entry.primary_code);
    failuresByFamily[family] = (failuresByFamily[family] ?? 0) + 1;
    const codes = [entry.primary_code, ...entry.secondary_codes];
    if (codes.some((code) => familyOf(code) === "GRD")) guardrailFailures += 1;
  }

  const passed = cases.filter((entry) => entry.pass).length;
  const p0Passed = p0.filter((entry) => entry.pass).length;

  return {
    model: meta.model,
    lane: meta.lane,
    total: cases.length,
    passed,
    pass_rate: rate(passed, cases.length),
    p0_total: p0.length,
    p0_passed: p0Passed,
    p0_pass_rate: rate(p0Passed, p0.length),
    failures_by_family: failuresByFamily,
    failures_by_code: failuresByCode,
    guardrail_failures: guardrailFailures,
    cases,
  };
}
