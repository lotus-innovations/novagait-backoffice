// Config for the spend-estimator entrypoint (*.script.ts). Mirrors the
// cassette script config: vitest is the repo's only TypeScript runner, and
// the root config includes *.test.ts only, so a normal `vitest run` never
// executes the estimator (which talks to the count_tokens endpoint).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../../../", import.meta.url)),
  test: {
    include: ["evals/runner/src/spend/*.script.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
  },
});
