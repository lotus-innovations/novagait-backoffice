// Drift gate for the /eval page's compiled data (LOT-109). Same contract as
// the fixtures and KB drift tests: if a results artifact changes without
// `npm run gen:eval-data -w web`, this fails CI. It spot-verifies every
// number the page headlines directly against the committed source JSONs
// rather than re-implementing the generator's projection.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CALIBRATION,
  CONTAINMENT,
  PUBLISHED,
  REGRADE_AFTER,
  REGRADE_BEFORE,
  REMEASURE,
} from "./eval-data.generated";

const REPO = fileURLToPath(new URL("../../../..", import.meta.url));
const PUBLISHED_DIR = join(REPO, "evals/results/matrix-2026-08-11");
const REMEASURE_DIR = join(REPO, "evals/results/matrix-2026-08-13-p130");

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8"));

describe("eval-data.generated", () => {
  it("matches the published matrix artifact", async () => {
    const matrix = await readJson(join(PUBLISHED_DIR, "matrix.json"));
    expect(PUBLISHED.generated_on).toBe(matrix.generated_on);
    expect(PUBLISHED.prompt_version).toBe(matrix.prompt_version);
    expect(PUBLISHED.sdk_version).toBe(matrix.sdk_version);
    expect(PUBLISHED.pricing_verified_on).toBe(matrix.pricing_verified_on);
    expect(PUBLISHED.rows.length).toBe(matrix.rows.length);
    for (const [index, row] of matrix.rows.entries()) {
      const slim = PUBLISHED.rows[index];
      expect(slim.model).toBe(row.model);
      expect(slim.mode).toBe(row.mode);
      expect(slim.passed).toBe(row.passed);
      expect(slim.pass_rate).toBe(row.pass_rate);
      expect(slim.p0_pass_rate).toBe(row.p0_pass_rate);
      expect(slim.cost_per_correct_run_usd).toBe(row.cost_per_correct_run_usd);
    }
  });

  it("matches the re-measure matrix artifact", async () => {
    const matrix = await readJson(join(REMEASURE_DIR, "matrix.json"));
    expect(REMEASURE.prompt_version).toBe(matrix.prompt_version);
    expect(REMEASURE.generated_on).toBe(matrix.generated_on);
    expect(REMEASURE.rows.map((row) => [row.mode, row.passed])).toEqual(
      matrix.rows.map((row: { mode: string; passed: number }) => [
        row.mode,
        row.passed,
      ]),
    );
  });

  it("matches both regrade artifacts (the before/after numbers)", async () => {
    const before = await readJson(
      join(PUBLISHED_DIR, "regrade-under-current-goldens.json"),
    );
    const after = await readJson(
      join(REMEASURE_DIR, "regrade-under-current-goldens.json"),
    );
    for (const [generated, source] of [
      [REGRADE_BEFORE, before],
      [REGRADE_AFTER, after],
    ] as const) {
      expect(generated.golden_revision_note).toBe(source.golden_revision_note);
      for (const [key, lane] of Object.entries(generated.lanes)) {
        const sourceLane = source.lanes[key];
        expect(sourceLane, key).toBeDefined();
        expect(lane.passed).toBe(sourceLane.summary.passed);
        expect(lane.p0_pass_rate).toBe(sourceLane.summary.p0_pass_rate);
        expect(lane.failures_by_family).toEqual(
          sourceLane.summary.failures_by_family,
        );
        expect(lane.failures_by_code).toEqual(
          sourceLane.summary.failures_by_code,
        );
        expect(lane.gates).toEqual(sourceLane.gates);
        expect(lane.failed_cases.length).toBe(sourceLane.failed_cases.length);
      }
    }
    // The headline the page leads with, pinned explicitly: GRD-004 zeroed.
    expect(
      REGRADE_BEFORE.lanes["claude-haiku-4-5:uncached"].failures_by_code[
        "GRD-004"
      ],
    ).toBe(29);
    expect(
      "GRD-004" in
        REGRADE_AFTER.lanes["claude-haiku-4-5:uncached"].failures_by_code,
    ).toBe(false);
  });

  it("containment constants still match skeptic2-findings.md", async () => {
    const text = await readFile(
      join(REMEASURE_DIR, "skeptic2-findings.md"),
      "utf8",
    );
    // The page's most safety-critical sentence: 55 of 56 held, INV-004 the
    // escape. Anchored to the committed verification pass, both lanes.
    expect(text).toContain("28/29"); // uncached: 29 attempts, 1 escaped
    expect(text).toContain("| 27 | 0 |"); // cached: 27 attempts, 0 escaped
    expect(text).toContain(CONTAINMENT.escape_case);
    expect(CONTAINMENT.deployed_tier_attempts).toBe(29 + 27);
    expect(CONTAINMENT.deployed_tier_held).toBe(
      CONTAINMENT.deployed_tier_attempts - 1,
    );
  });

  it("calibration constants still match calibration-results.md", async () => {
    const text = await readFile(
      join(PUBLISHED_DIR, "calibration-results.md"),
      "utf8",
    );
    expect(text).toContain(
      `Verdict agreement: ${CALIBRATION.verdict_agreement}`,
    );
    expect(text).toContain(
      `Mean absolute score difference: ${CALIBRATION.mean_abs_score_diff}`,
    );
    expect(CALIBRATION.direction).toContain("conservative");
  });
});
