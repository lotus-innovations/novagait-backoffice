// Config for the live smoke entrypoint (*.script.ts). The root vitest config
// includes *.test.ts only, so a normal `npm test` - and therefore CI - can
// never pick this up. Running it requires a key in the environment and
// spends real money.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  root: fileURLToPath(new URL("../../../", import.meta.url)),
  test: {
    include: ["packages/pipeline/scripts/*.script.ts"],
    testTimeout: 300_000,
  },
});
