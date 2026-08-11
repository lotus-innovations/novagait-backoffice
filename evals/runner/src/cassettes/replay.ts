// Replay comparator (LOT-106, spec 09 §4). Loads the golden cases and the
// committed cassettes, grades with the LOT-96 graders, summarizes, and
// compares the summary exactly against evals/baseline/replay.json. Key-free
// and offline: this is the blocking CI lane.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { VENDORS } from "@novagait/mock-backend";
import { grade, type GradeResult } from "../grade";
import { loadGoldenCases, type GoldenCase } from "../golden";
import { summarize, type EvalSummary } from "../summary";
import {
  CASSETTE_LANE,
  canonicalize,
  cassetteFileName,
  parseCassette,
  type Cassette,
} from "./cassette";
import { CASSETTE_DIR, GOLDEN_DIR, REPLAY_BASELINE_PATH } from "./paths";

export interface ReplayBaseline {
  lane: string;
  pipeline: string;
  generated_by: string;
  known_failing: {
    documented: { reference: string; case_ids: string[] };
    undocumented: {
      reference: string;
      note: string;
      reasons: Record<string, string[]>;
    };
  };
  summary: EvalSummary;
}

export interface ReplayResult {
  results: GradeResult[];
  summary: EvalSummary;
  cassettes: Cassette[];
}

export async function loadCassettes(
  dir: string = CASSETTE_DIR,
): Promise<Cassette[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  const cassettes: Cassette[] = [];
  for (const file of files.sort()) {
    cassettes.push(
      parseCassette(await readFile(join(dir, file), "utf8"), file),
    );
  }
  return cassettes;
}

// A golden with no cassette silently shrinks the lane; a cassette with no
// golden grades nothing. Both are failures, not warnings.
export function coverageProblems(
  cases: GoldenCase[],
  cassettes: Cassette[],
): string[] {
  const recorded = new Set(cassettes.map((cassette) => cassette.case_id));
  const golden = new Set(cases.map((entry) => entry.id));
  const problems: string[] = [];
  for (const id of golden) {
    if (!recorded.has(id)) {
      problems.push(`golden ${id} has no cassette (${cassetteFileName(id)})`);
    }
  }
  for (const id of recorded) {
    if (!golden.has(id)) problems.push(`cassette ${id} has no golden case`);
  }
  return problems.sort();
}

export interface ReplayOptions {
  goldenDir?: string;
  cassetteDir?: string;
}

export async function replay(
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const cases = await loadGoldenCases(options.goldenDir ?? GOLDEN_DIR);
  const cassettes = await loadCassettes(options.cassetteDir ?? CASSETTE_DIR);
  const problems = coverageProblems(cases, cassettes);
  if (problems.length > 0) {
    throw new Error(`replay coverage mismatch:\n  ${problems.join("\n  ")}`);
  }

  const byId = new Map(
    cassettes.map((cassette) => [cassette.case_id, cassette]),
  );
  const results = cases.map((goldenCase) =>
    grade(goldenCase, byId.get(goldenCase.id)!.outcome, { vendors: VENDORS }),
  );

  const models = new Set(
    cassettes.map((cassette) => cassette.recorded_with.model),
  );
  if (models.size !== 1) {
    throw new Error(`cassettes mix models: ${[...models].sort().join(", ")}`);
  }

  return {
    results,
    cassettes,
    summary: summarize(results, {
      model: [...models][0]!,
      lane: CASSETTE_LANE,
    }),
  };
}

export function failingCaseIds(summary: EvalSummary): string[] {
  return summary.cases
    .filter((entry) => !entry.pass)
    .map((entry) => entry.case_id)
    .sort();
}

// Deep value diff with paths, so a mismatch reads as a location and two
// values rather than as two pretty-printed blobs.
export function diffValues(
  actual: unknown,
  expected: unknown,
  path = "summary",
): string[] {
  if (canonicalize(actual) === canonicalize(expected)) return [];
  const bothObjects =
    typeof actual === "object" &&
    actual !== null &&
    typeof expected === "object" &&
    expected !== null &&
    Array.isArray(actual) === Array.isArray(expected);
  if (!bothObjects) {
    return [
      `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    ];
  }
  const keys = [
    ...new Set([
      ...Object.keys(actual as object),
      ...Object.keys(expected as object),
    ]),
  ].sort();
  const diffs: string[] = [];
  for (const key of keys) {
    const left = (actual as Record<string, unknown>)[key];
    const right = (expected as Record<string, unknown>)[key];
    if (!(key in (actual as object))) {
      diffs.push(
        `${path}.${key}: missing (baseline has ${JSON.stringify(right)})`,
      );
      continue;
    }
    if (!(key in (expected as object))) {
      diffs.push(`${path}.${key}: unexpected ${JSON.stringify(left)}`);
      continue;
    }
    diffs.push(...diffValues(left, right, `${path}.${key}`));
  }
  return diffs;
}

export async function loadBaseline(
  path: string = REPLAY_BASELINE_PATH,
): Promise<ReplayBaseline> {
  return JSON.parse(await readFile(path, "utf8")) as ReplayBaseline;
}

export interface ReplayCheck {
  summary: EvalSummary;
  baseline: ReplayBaseline;
  diffs: string[];
}

export async function checkAgainstBaseline(
  options: ReplayOptions & { baselinePath?: string } = {},
): Promise<ReplayCheck> {
  const { summary } = await replay(options);
  const baseline = await loadBaseline(options.baselinePath);
  return { summary, baseline, diffs: diffValues(summary, baseline.summary) };
}
