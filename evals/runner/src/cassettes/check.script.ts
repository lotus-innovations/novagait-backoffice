// Entrypoint: npm run -w @novagait/evals-runner cassettes:check
// Re-records into a scratch directory and fails on any difference from the
// committed cassettes (harness drift).
import { expect, test } from "vitest";
import { cassetteDrift } from "./drift";

test("committed cassettes match a fresh recording", async () => {
  const problems = await cassetteDrift();
  expect(problems, `cassette drift:\n  ${problems.join("\n  ")}`).toEqual([]);
});
