// Release gates (spec 09 §4, arch doc B lane 2). Every number lives in
// evals/thresholds.json; nothing in this file re-states a threshold as a
// literal. The gate function is pure so the report page, the CLI, and the
// tests all evaluate identical rules.

import { readFile } from "node:fs/promises";
import thresholdsData from "../../thresholds.json";
import type { EvalSummary } from "./summary";

export interface ThresholdGates {
  p0_pass_rate_min: number;
  guardrail_family_max_failures: number;
  p0_regression_flip_max: number;
  aggregate_drop_max_points: number;
}

export interface Thresholds {
  version: number;
  source: string;
  lane: string;
  p0_tag: string;
  gates: ThresholdGates;
  notes: Record<string, string>;
}

export const THRESHOLDS: Thresholds = thresholdsData;
export const P0_TAG = THRESHOLDS.p0_tag;

// Guardrail failures are counted by family prefix, so a new GRD-* code is
// covered by the hard-zero gate the day it is added to the taxonomy.
export const GUARDRAIL_FAMILY = "GRD";

const GATE_KEYS: (keyof ThresholdGates)[] = [
  "p0_pass_rate_min",
  "guardrail_family_max_failures",
  "p0_regression_flip_max",
  "aggregate_drop_max_points",
];

export function parseThresholds(candidate: unknown): Thresholds {
  if (candidate === null || typeof candidate !== "object") {
    throw new Error("thresholds must be an object");
  }
  const raw = candidate as Record<string, unknown>;
  if (typeof raw.p0_tag !== "string" || raw.p0_tag === "") {
    throw new Error("thresholds.p0_tag must be a non-empty string");
  }
  const gates = raw.gates as Record<string, unknown> | undefined;
  if (!gates) throw new Error("thresholds.gates is required");
  for (const key of GATE_KEYS) {
    if (typeof gates[key] !== "number" || Number.isNaN(gates[key])) {
      throw new Error(`thresholds.gates.${key} must be a number`);
    }
  }
  return candidate as Thresholds;
}

export async function loadThresholds(path: string): Promise<Thresholds> {
  return parseThresholds(JSON.parse(await readFile(path, "utf8")));
}

export interface GateResult {
  id: string;
  pass: boolean;
  // Every live-lane gate blocks release; the flag is explicit so the report
  // page never has to infer it.
  blocking: boolean;
  detail: string;
}

export interface GateEvaluation {
  pass: boolean;
  gates: GateResult[];
}

function gate(id: string, pass: boolean, detail: string): GateResult {
  return { id, pass, blocking: true, detail };
}

export function evaluateGates(
  summary: EvalSummary,
  baseline: EvalSummary | null = null,
  thresholds: Thresholds = THRESHOLDS,
): GateEvaluation {
  const limits = thresholds.gates;
  const gates: GateResult[] = [];

  gates.push(
    summary.p0_total === 0
      ? gate("p0_pass_rate", true, "no P0 cases in this run")
      : gate(
          "p0_pass_rate",
          summary.p0_pass_rate >= limits.p0_pass_rate_min,
          `P0 pass rate ${summary.p0_pass_rate.toFixed(3)} vs minimum ${limits.p0_pass_rate_min}`,
        ),
  );

  // Reads guardrail_failures (GRD anywhere in a failing case's codes), not
  // failures_by_family (primaries only): a SYS primary must not mask a
  // demoted guardrail miss from the hard-zero gate.
  const guardrailFailures = summary.guardrail_failures;
  gates.push(
    gate(
      "guardrail_hard_zero",
      guardrailFailures <= limits.guardrail_family_max_failures,
      `${guardrailFailures} ${GUARDRAIL_FAMILY}-family failures, maximum ${limits.guardrail_family_max_failures}`,
    ),
  );

  if (baseline === null) {
    gates.push(
      gate("p0_no_regression", true, "no baseline to compare against"),
    );
    gates.push(
      gate("aggregate_no_drop", true, "no baseline to compare against"),
    );
    return { pass: gates.every((entry) => entry.pass), gates };
  }

  const baselineById = new Map(
    baseline.cases.map((entry) => [entry.case_id, entry] as const),
  );
  const summaryIds = new Set(summary.cases.map((entry) => entry.case_id));
  const flips = summary.cases
    .filter((entry) => entry.tags.includes(thresholds.p0_tag) && !entry.pass)
    .filter((entry) => baselineById.get(entry.case_id)?.pass === true)
    .map((entry) => entry.case_id);
  // A passing baseline P0 case that vanished from the run counts as a flip:
  // deleting or skipping a failing golden must not clear the gate.
  for (const entry of baseline.cases) {
    if (
      entry.tags.includes(thresholds.p0_tag) &&
      entry.pass &&
      !summaryIds.has(entry.case_id)
    ) {
      flips.push(`${entry.case_id} (missing from run)`);
    }
  }
  gates.push(
    gate(
      "p0_no_regression",
      flips.length <= limits.p0_regression_flip_max,
      flips.length === 0
        ? "no P0 case flipped pass to fail"
        : `P0 pass-to-fail flips: ${flips.join(", ")}`,
    ),
  );

  // toFixed(6) kills float dust: a drop of exactly the limit must pass
  // (0.93 -> 0.91 computes as 2.0000000000000018 without it).
  const dropPoints = Number(
    ((baseline.pass_rate - summary.pass_rate) * 100).toFixed(6),
  );
  gates.push(
    gate(
      "aggregate_no_drop",
      dropPoints <= limits.aggregate_drop_max_points,
      `aggregate pass rate moved ${(-dropPoints).toFixed(2)} points vs baseline (max drop ${limits.aggregate_drop_max_points})`,
    ),
  );

  return { pass: gates.every((entry) => entry.pass), gates };
}
