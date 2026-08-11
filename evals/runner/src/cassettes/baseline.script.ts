// Entrypoint: npm run -w @novagait/evals-runner cassettes:baseline
// Rewrites evals/baseline/replay.json from the committed cassettes. Run it
// only when a change to the lane is intended; the diff is the review.
import { test } from "vitest";
import { replay } from "./replay";
import { writeBaseline } from "./baseline";

test("write evals/baseline/replay.json from the committed cassettes", async () => {
  const { summary } = await replay();
  await writeBaseline(summary);
  console.info(
    `baseline written: ${summary.passed}/${summary.total} pass, ${summary.total - summary.passed} known failures`,
  );
});
