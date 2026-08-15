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
import { CAVEAT_GLOSS } from "../app/eval/page";

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

  // bd-100: the caveats are republished verbatim, so they cannot be edited for
  // readability. Each one carries a plain-language gloss instead. If the
  // generator emits a new caveat key, that gloss is missing and the page would
  // silently publish unexplained dense text. Fail here instead.
  it("every published metric caveat has a plain-language gloss", () => {
    const missing = Object.keys(PUBLISHED.metric_caveats).filter(
      (key) => !CAVEAT_GLOSS[key],
    );
    expect(missing).toEqual([]);
  });

  // The glosses are prose on a page whose every number comes from an artifact.
  // A digit in a gloss would be an unsourced number.
  it("no gloss introduces a number", () => {
    const withDigits = Object.entries(CAVEAT_GLOSS)
      .filter(([, text]) => /\d/.test(text))
      .map(([key]) => key);
    expect(withDigits).toEqual([]);
  });

  // bd-100: the client-facing engagement doc restated these figures in prose.
  // They are now emitted by gen:eval-data into a marked region. This fails if
  // someone edits the region by hand, or regenerates the data without
  // re-running the generator, so the deliverable cannot drift from /eval.
  it("engagement doc numbers match the generated eval data", async () => {
    const doc = await readFile(
      join(REPO, "docs/engagement/03-architecture.md"),
      "utf8",
    );
    const region = doc.slice(
      doc.indexOf("<!-- eval-numbers:start -->"),
      doc.indexOf("<!-- eval-numbers:end -->"),
    );
    expect(region).not.toBe("");

    const uncached = REGRADE_AFTER.lanes["claude-haiku-4-5:uncached"];
    const cached = REGRADE_AFTER.lanes["claude-haiku-4-5:cached"];
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

    expect(region).toContain(
      `**${CONTAINMENT.deployed_tier_attempts} attempts**`,
    );
    expect(region).toContain(
      `${uncached.p0_pass_rate.toFixed(3)} and ${cached.p0_pass_rate.toFixed(3)}`,
    );
    expect(region).toContain(
      `${pct(uncached.pass_rate)} and ${pct(cached.pass_rate)}`,
    );
    expect(region).toContain(`all ${uncached.total} cases`);

    // The doc must not reintroduce a figure /eval does not publish. "8 of 14"
    // contradicted /eval's "9 before and 9 after" on the same lane.
    expect(region).not.toMatch(/\d+ of \d+ on the\s+measured lane/);
  });

  // The same doc restated the containment pair in its own prose, outside the
  // generated region. That is half-applied single-sourcing, and it drifts on
  // the next regeneration. The generator owns this region too now.
  it("engagement doc containment figures match the generated eval data", async () => {
    const doc = await readFile(
      join(REPO, "docs/engagement/03-architecture.md"),
      "utf8",
    );
    const region = doc.slice(
      doc.indexOf("<!-- eval-containment:start -->"),
      doc.indexOf("<!-- eval-containment:end -->"),
    );
    expect(region).not.toBe("");
    expect(region).toContain(`**${CONTAINMENT.deployed_tier_attempts} times**`);
    expect(region).toContain(
      `stopped ${CONTAINMENT.deployed_tier_held} of them`,
    );

    // No containment figure may appear outside the region it is generated into.
    const outside = doc.replace(region, "");
    expect(outside).not.toContain(
      `${CONTAINMENT.deployed_tier_attempts} times`,
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
