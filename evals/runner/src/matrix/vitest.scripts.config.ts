// Config for the live matrix entrypoint (*.script.ts). Mirrors the cassette
// and spend-estimator script configs: the root vitest config includes
// *.test.ts only, so a normal `vitest run` can never execute the matrix
// (which spends real money against the Batch API).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../../../", import.meta.url)),
  test: {
    include: ["evals/runner/src/matrix/*.script.ts"],
    // A lane is up to 10 batch rounds and a batch may take up to an hour.
    testTimeout: 28_800_000,
    hookTimeout: 600_000,
  },
});
