// Config for the cassette CLI entrypoints (*.script.ts). Vitest is the
// repo's only TypeScript runner, so the recorder and the replay comparator
// are driven through it; the root config deliberately does not pick these
// files up (it includes *.test.ts only), so a normal `vitest run` never
// rewrites cassettes.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../../../", import.meta.url)),
  test: {
    include: ["evals/runner/src/cassettes/*.script.ts"],
    testTimeout: 120_000,
  },
});
