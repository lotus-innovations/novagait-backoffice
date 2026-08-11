// Cassette format for the replay lane (spec 09 §4). A cassette is the graded
// view of one deterministic (mock-lane) run: exactly the RunOutcome the
// graders consume, plus provenance. No trace, no backend state, no prose.
//
// Determinism is the contract: re-recording must produce byte-identical
// files, so every volatile value is normalized or excluded at this boundary
// (see evals/cassettes/README.md for the full list).

import type { RunOutcome } from "../outcome";

export const CASSETTE_LANE = "mock-replay";
export const CASSETTE_PIPELINE = "deterministic";
export const CASSETTE_VERSION = 1;

export interface CassetteProvenance {
  case_id: string;
  lane: typeof CASSETTE_LANE;
  pipeline: typeof CASSETTE_PIPELINE;
  recorded_with: {
    prompt_version: string;
    tools_version: string;
    model: string;
    mode: string;
  };
}

export interface Cassette extends CassetteProvenance {
  version: number;
  outcome: RunOutcome;
}

// The mock parser has no null: a total it cannot find is 0 and an invoice
// number it cannot find is "UNKNOWN" (packages/pipeline/src/parse.ts). The
// golden dataset expresses both as null, and the parse-consistency test in
// packages/pipeline maps the same two sentinels, so the mapping happens here
// too rather than being re-litigated per grader.
export const PARSER_NULL_SENTINELS = {
  invoice_number: "UNKNOWN",
  total_cents: 0,
} as const;

// Run ids are ULIDs: the one genuinely volatile field inside RunOutcome.
export const cassetteRunId = (caseId: string): string => `RUN-${caseId}`;

export function normalizeOutcome(
  outcome: RunOutcome,
  caseId: string,
): RunOutcome {
  const fields = { ...outcome.fields };
  if (fields.invoice_number === PARSER_NULL_SENTINELS.invoice_number) {
    fields.invoice_number = null;
  }
  if (fields.total_cents === PARSER_NULL_SENTINELS.total_cents) {
    fields.total_cents = null;
  }
  return {
    ...outcome,
    case_id: caseId,
    run_id: cassetteRunId(caseId),
    fields,
  };
}

export function cassetteFileName(caseId: string): string {
  return `${caseId}.json`;
}

// Stable serialization: keys sorted at every depth so the on-disk bytes
// depend on the values alone, never on property insertion order.
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return Object.fromEntries(entries.map(([key, val]) => [key, sortValue(val)]));
}

export function serializeCassette(cassette: Cassette): string {
  return `${JSON.stringify(sortValue(cassette), null, 2)}\n`;
}

// Canonical form for comparison. On-disk formatting belongs to repo-wide
// prettier, so drift is compared on this canonical string rather than on
// raw bytes: a reformat is not drift, a changed value is.
export function canonicalize(cassette: unknown): string {
  return JSON.stringify(sortValue(cassette));
}

export function parseCassette(text: string, source: string): Cassette {
  const parsed = JSON.parse(text) as Partial<Cassette>;
  if (typeof parsed.case_id !== "string") {
    throw new Error(`${source}: cassette.case_id is required`);
  }
  if (parsed.lane !== CASSETTE_LANE) {
    throw new Error(`${source}: cassette.lane must be ${CASSETTE_LANE}`);
  }
  if (parsed.outcome === undefined || parsed.outcome === null) {
    throw new Error(`${source}: cassette.outcome is required`);
  }
  return parsed as Cassette;
}
