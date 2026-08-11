// Failure taxonomy (spec 09 §3, arch doc B). The code definitions and the
// primary-code precedence live in evals/taxonomy.json so the /eval report
// page renders from data; this module is the typed view over that file. A
// code that appears in a grader but not in the JSON is a bug, and
// assertKnownCode() makes it a loud one.

import taxonomyData from "../../taxonomy.json";

export interface TaxonomyCode {
  code: string;
  label: string;
  definition: string;
}

export interface TaxonomyFamily {
  prefix: string;
  family: string;
  description: string;
  codes: TaxonomyCode[];
}

export interface Taxonomy {
  version: number;
  source: string;
  rule: string;
  precedence: string[];
  precedence_rationale: string;
  families: TaxonomyFamily[];
  known_gaps: string[];
}

export const TAXONOMY: Taxonomy = taxonomyData;

export const FAMILY_PRECEDENCE: readonly string[] = TAXONOMY.precedence;

const CODE_INDEX = new Map<string, TaxonomyCode>(
  TAXONOMY.families.flatMap((family) =>
    family.codes.map((code) => [code.code, code] as const),
  ),
);

export function familyOf(code: string): string {
  return code.split("-")[0];
}

export function taxonomyCode(code: string): TaxonomyCode | undefined {
  return CODE_INDEX.get(code);
}

export function assertKnownCode(code: string): string {
  if (!CODE_INDEX.has(code)) {
    throw new Error(`unknown taxonomy code: ${code}`);
  }
  return code;
}

// Lower rank wins. Unknown families sort last rather than throwing: the
// ranking runs inside grading, and a mislabeled code should surface as a
// bad chart entry, not as a crashed eval run.
export function familyRank(code: string): number {
  const index = FAMILY_PRECEDENCE.indexOf(familyOf(code));
  return index === -1 ? FAMILY_PRECEDENCE.length : index;
}

// Primary = the most upstream cause by family precedence, ties broken by
// the order the checks ran (stable sort over the input order).
export function rankCodes(codes: string[]): string[] {
  const seen = new Set<string>();
  const unique = codes.filter((code) => {
    if (seen.has(code)) return false;
    seen.add(code);
    return true;
  });
  return unique
    .map((code, index) => ({ code, index }))
    .sort(
      (a, b) => familyRank(a.code) - familyRank(b.code) || a.index - b.index,
    )
    .map((entry) => entry.code);
}
