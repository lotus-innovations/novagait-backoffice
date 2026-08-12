// The opus row of the 2026-08-12 matrix is not a clean capability number: 27
// of its 73 runs ended on the 2048-token output cap mid-draft. A reader who
// meets that fact below the gates section has already compared the tiers.

import { expect, test } from "vitest";
import { renderMatrixTable, type MatrixRow } from "./results";

const row = (over: Partial<MatrixRow> = {}): MatrixRow => ({
  model: "claude-opus-5",
  mode: "uncached",
  cases: 73,
  passed: 27,
  pass_rate: 0.37,
  p0_pass_rate: 0.63,
  total_cost_usd: 9.81,
  mean_cost_per_run_usd: 0.1344,
  cost_per_correct_run_usd: 0.3634,
  p50_latency_ms: null,
  p95_latency_ms: null,
  mean_iterations: 4.9,
  model_policy_divergence: 4,
  output_capped_runs: 27,
  ...over,
});

test("a truncated lane carries the output-cap caveat with the table", () => {
  const rendered = renderMatrixTable([row()]);
  expect(rendered).toContain("OUTPUT CAP");
  expect(rendered).toContain("27 of 73 runs ended on the output-token cap");
  expect(rendered.indexOf("OUTPUT CAP")).toBeGreaterThan(
    rendered.indexOf("claude-opus-5"),
  );
});

test("a lane that never truncated says nothing about the cap", () => {
  const rendered = renderMatrixTable([row({ output_capped_runs: 0 })]);
  expect(rendered).not.toContain("OUTPUT CAP");
});

test("divergence renders n/a when the join could not be made", () => {
  const rendered = renderMatrixTable([
    row({ model_policy_divergence: null, output_capped_runs: 0 }),
  ]);
  expect(rendered).toContain("n/a |");
});
