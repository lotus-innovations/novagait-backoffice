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
    // No test timeout. INCIDENT 2026-08-12: this was 28_800_000ms (8h) and
    // vitest hit it mid-run, killing a checkpointed paid run with an opus
    // batch of 16 requests in flight. Those requests were billed and their
    // results never read (recovered afterwards by MATRIX_SWEEP=1).
    // The harness's own clock must never be the thing that kills a paid run:
    // the real bounds are the ledger's $65 hard stop, the per-batch maxWait,
    // and the Batch API's own 24h expiry. 0 disables the timeout in vitest.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
