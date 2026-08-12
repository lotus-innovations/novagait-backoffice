// Regression guard on the workpaper generator's narrative.
//
// The §10 "side findings" prose used to hardcode a moment in time: the
// per-run cap as a `0.02` literal, the prefix as 3,162 tokens / 934 short of
// Haiku's minimum, MAX_ITERATIONS as 8, and the thinking mismatch as
// unresolved. After LOT-119 every one of those was false, and the generator
// would have kept emitting them into each new S9 artifact. They are now
// derived from the measured estimate and the live policy constants.
//
// This test renders the committed post-LOT-119 estimate and asserts the
// derivation actually holds. It runs in the normal key-free `npm test` lane:
// the renderer is pure, and measure.ts constructs its Anthropic client
// lazily so importing this chain needs no credentials.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MAX_ITERATIONS, MAX_RUN_COST_MICRO_USD } from "@novagait/agent";
import type { SpendEstimate } from "./cost";
import { renderMarkdown } from "./report";
import { EVALS_DIR } from "../cassettes/paths";

const ESTIMATE = `${EVALS_DIR}spend-estimate-2026-08-11-post-lot119.json`;

async function render(): Promise<string> {
  const raw = JSON.parse(await readFile(ESTIMATE, "utf8"));
  return renderMarkdown(raw as SpendEstimate, {
    promptVersion: raw.meta.prompt_version,
    toolsVersion: raw.meta.tools_version,
    countTokensCalls: raw.meta.count_tokens_calls,
    iterationCap: raw.meta.iteration_cap,
    casesOverCap: raw.meta.cases_over_iteration_cap,
  });
}

describe("spend workpaper generator", () => {
  it("renders without credentials", async () => {
    // The assertion is that the import chain and render complete at all:
    // a regression to eager client construction fails here, in CI, rather
    // than the next time someone runs the estimator.
    expect((await render()).length).toBeGreaterThan(1000);
  });

  it("derives the per-run cap from policy-constants", async () => {
    const md = await render();
    const cap = MAX_RUN_COST_MICRO_USD / 1_000_000;
    expect(md).toContain(`$${cap.toFixed(4)}`);
    // The pre-LOT-119 literal must not reappear as a hardcoded cap.
    expect(md).not.toContain("$0.02 per-run cap");
  });

  it("states the prefix and iteration cap as measured, not as remembered", async () => {
    const raw = JSON.parse(await readFile(ESTIMATE, "utf8"));
    const haiku = raw.aggregates.find(
      (a: { model: string }) => a.model === "claude-haiku-4-5",
    );
    const md = await render();
    expect(md).toContain(haiku.prefixTokens.toLocaleString("en-US"));
    expect(md).not.toContain("3,162");
    expect(md).not.toContain("934 tokens short");
    expect(md).not.toContain("[DEFAULT] of 8");
    expect(raw.meta.iteration_cap).toBe(MAX_ITERATIONS);
  });

  it("does not describe the thinking mismatch as unresolved", async () => {
    const md = await render();
    expect(md).not.toContain("The loop sets no `thinking` parameter");
    expect(md).not.toContain("Decide explicitly before running.");
  });
});
