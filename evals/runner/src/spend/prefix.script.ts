// Entrypoint: measure the cacheable system+tools prefix per matrix model.
//
//   set -a; . ~/dev/lotus/demos/secrets/backoffice-runtime.env; set +a
//   npm run -w @novagait/evals-runner spend:prefix
//
// Why this exists: prompt caching is silently ignored when the cacheable
// prefix is under the model's minimum (no error, no cache_creation tokens).
// claude-haiku-4-5 is the production model and has a 4,096-token minimum, so
// the prefix has to be measured, not assumed, whenever prompts.ts or the
// tool surface changes. LOT-101 found the prefix at 3,162 tokens; LOT-119
// grew it past the minimum.
//
// Calls messages.count_tokens ONLY (free endpoint). Never messages.create.

import { test, expect } from "vitest";
import { PROMPT_VERSION, TOOLS_VERSION } from "./payloads";
import { MATRIX_MODELS, measurePrefixTokens } from "./measure";

// platform.claude.com/docs/en/build-with-claude/prompt-caching, verified
// 2026-08-11. Below the minimum, cache_control is silently ignored.
export const CACHE_MINIMUM_TOKENS: Record<string, number> = {
  "claude-haiku-4-5": 4096,
  "claude-sonnet-5": 1024,
  "claude-opus-5": 512,
};

test("system+tools prefix clears the cache minimum on every matrix model", async () => {
  process.stdout.write(
    `prompt ${PROMPT_VERSION}, tools ${TOOLS_VERSION}\n` +
      `model                 prefix   minimum   headroom\n`,
  );
  for (const model of MATRIX_MODELS) {
    const prefix = await measurePrefixTokens(model);
    const minimum = CACHE_MINIMUM_TOKENS[model];
    process.stdout.write(
      `${model.padEnd(20)} ${String(prefix).padStart(6)} ` +
        `${String(minimum).padStart(9)} ${String(prefix - minimum).padStart(10)}\n`,
    );
    expect(prefix).toBeGreaterThanOrEqual(minimum);
  }
});
