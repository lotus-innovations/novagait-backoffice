// Entrypoint: npm run -w @novagait/evals-runner cassettes:replay
// Grades the committed cassettes and compares the summary to the committed
// baseline. Nonzero exit + a per-field diff on mismatch.
import { expect, test } from "vitest";
import { checkAgainstBaseline } from "./replay";

test("replay summary matches evals/baseline/replay.json exactly", async () => {
  const { summary, diffs } = await checkAgainstBaseline();
  if (diffs.length > 0) {
    console.error(
      `replay diverged from the baseline:\n  ${diffs.join("\n  ")}`,
    );
  }
  expect(diffs, diffs.join("\n")).toEqual([]);
  console.info(
    `replay: ${summary.passed}/${summary.total} pass, p0 ${summary.p0_passed}/${summary.p0_total}`,
  );
});
