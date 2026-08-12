// Markdown workpaper renderer for the LOT-105 spend estimate.

import {
  CACHE_HIT_SCENARIOS,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  CONTINGENCY,
  PRICING,
  PRICING_SOURCES,
  type SpendEstimate,
} from "./cost";
import { MATRIX_MODELS } from "./measure";
import { PREAMBLE_TEXT } from "./payloads";

const usd = (n: number) => `$${n.toFixed(2)}`;
const usd4 = (n: number) => `$${n.toFixed(4)}`;
const num = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 0 });

export function renderMarkdown(
  e: SpendEstimate,
  meta: {
    promptVersion: string;
    toolsVersion: string;
    countTokensCalls: number;
    iterationCap: number;
    casesOverCap: { caseId: string; turns: number }[];
  },
): string {
  const L: string[] = [];
  const push = (...lines: string[]) => L.push(...lines);

  push(
    "# LOT-105 live eval matrix: spend estimate (workpaper)",
    "",
    `Generated ${e.generatedOn}. Pricing verified ${e.pricingVerifiedOn}.`,
    `Prompt version ${meta.promptVersion}, tools version ${meta.toolsVersion}.`,
    "",
    "S9 gate artifact: the dollar figure that must be shown to Abhinav before",
    "any live run (spec 09 §4, spec 13 §3).",
    "",
    "**Zero live spend was incurred producing this document.** Every token",
    `count below came from \`messages.count_tokens\` (${num(meta.countTokensCalls)} calls),`,
    "which the docs state is free to use. No call to `messages.create` or any",
    "token-consuming endpoint was made.",
    "",
    "---",
    "",
    "## 1. Headline",
    "",
    "| Line | Raw | With 1.3x contingency |",
    "|---|---:|---:|",
    `| Best case (98% batch cache-hit rate) | **${usd(e.totals.rawUsdCachedBest)}** | **${usd(e.totals.withContingencyUsdCachedBest)}** |`,
    `| Worst case (30% batch cache-hit rate) | **${usd(e.totals.rawUsd)}** | **${usd(e.totals.withContingencyUsd)}** |`,
    "",
    "The matrix ships **both** cache columns (spec 09 §4 publishes cached and",
    "uncached side by side), so the headline is the sum of the two columns",
    "plus judge, calibration, and the interactive latency pass, not one",
    "column or the other.",
    "",
    "---",
    "",
    "## 2. Method",
    "",
    "1. **Base payload, measured not modelled.** For each of the",
    `   ${e.caseCount} golden cases the estimator reconstructs the first live`,
    "   request exactly as `packages/agent/src/loop.ts` would send it: the",
    "   frozen system prompt from `prompts.ts` (PROMPT_VERSION",
    `   ${meta.promptVersion}), all 8 tool JSON Schemas built the same way the`,
    "   raw driver builds them (`z.toJSONSchema(toolInputSchemas[name])`), and",
    "   an intake user turn carrying the inbox-item metadata plus the document",
    "   body from the compiled fixtures. That payload goes to `count_tokens`.",
    "2. **Multi-turn growth, measured from the cassettes.** Each cassette in",
    "   `evals/cassettes/INV-*.json` records the case's actual `tool_calls`",
    "   sequence. The estimator replays that sequence, building one turn per",
    "   call: an assistant message (short preamble + `tool_use` block with the",
    "   real input the model would emit) and a user message carrying the real",
    "   tool result, produced by invoking the deterministic mock backend",
    "   (`getVendor`, `getPurchaseOrder`, `getReceivingForPo`, `invoiceExists`,",
    "   `searchKb`). The conversation is counted **at every iteration**, because",
    "   the API re-reads the whole prefix each turn; billed input is the sum of",
    "   those per-iteration counts, not the final conversation length.",
    "3. **Output tokens, measured per iteration.** For each turn the estimator",
    "   counts the conversation with the assistant message appended and",
    "   subtracts the conversation without it. That prices the `tool_use`",
    "   blocks exactly, including `draft_action`, which carries the full",
    "   extraction with source spans and dominates output on every case.",
    "4. **Per-model tokenisation.** Every count is taken separately against",
    "   `claude-haiku-4-5`, `claude-sonnet-5`, and `claude-opus-5`; these models",
    "   do not share a tokenizer, so a single count reused across the matrix",
    "   would be wrong.",
    "",
    "### Output-token assumption (the one modelled quantity)",
    "",
    "Per-iteration output = measured `tool_use` block size + a short preamble",
    `sentence, held constant at: "${PREAMBLE_TEXT}"`,
    "",
    "The final turn is a measured sample of a closing summary. Everything else",
    "in the output column is measured, not assumed. Thinking tokens are **not**",
    "included: the agent runs on `claude-haiku-4-5` in production and the loop",
    "sets no `thinking` parameter; see Assumption A6 for the exposure on the",
    "Sonnet 5 and Opus 5 rows, where thinking is on by default.",
    "",
    "---",
    "",
    "## 3. Measured token tables",
    "",
    "Per model, summed across all " + e.caseCount + " cases (one run each):",
    "",
    "| Model | Cacheable prefix (sys+tools) | Mean iterations/run | Mean input tok/run | Mean output tok/run | Total input tok | Total output tok |",
    "|---|---:|---:|---:|---:|---:|---:|",
  );

  for (const a of e.aggregates) {
    push(
      `| \`${a.model}\` | ${num(a.prefixTokens)}${a.cacheApplies ? "" : " ⚠"} | ${a.meanIterations.toFixed(1)} | ${num(a.meanInputTokensPerRun)} | ${num(a.meanOutputTokensPerRun)} | ${num(a.totalInputTokens)} | ${num(a.totalOutputTokens)} |`,
    );
  }

  push(
    "",
    "Input split into the shared cacheable prefix (re-read once per iteration)",
    "and the per-case suffix that can never be shared:",
    "",
    "| Model | Total prefix tok (re-reads) | Total suffix tok | Prefix share of input |",
    "|---|---:|---:|---:|",
  );
  for (const a of e.aggregates) {
    const share = a.totalInputTokens
      ? (100 * a.totalPrefixTokens) / a.totalInputTokens
      : 0;
    push(
      `| \`${a.model}\` | ${num(a.totalPrefixTokens)} | ${num(a.totalSuffixTokens)} | ${share.toFixed(1)}% |`,
    );
  }

  const noCache = e.aggregates.filter((a) => !a.cacheApplies);
  if (noCache.length > 0) {
    push(
      "",
      "> ⚠ **Cache minimum not met.** " +
        noCache
          .map(
            (a) =>
              `\`${a.model}\` needs a ${num(PRICING[a.model].minCacheablePrefixTokens)}-token minimum cacheable prefix; ours is ${num(a.prefixTokens)}.`,
          )
          .join(" ") +
        " Below the minimum, `cache_control` is silently ignored (no error is" +
        " returned), so the cached column for that model is identical to the" +
        " uncached column. This is a real finding, not a rounding note: it is" +
        " the single largest correction to a naive estimate.",
    );
  }

  push(
    "",
    "---",
    "",
    "## 4. Pricing table (verified " + e.pricingVerifiedOn + ")",
    "",
    "| Model | Input $/MTok | Output $/MTok | Min cacheable prefix |",
    "|---|---:|---:|---:|",
  );
  for (const m of MATRIX_MODELS) {
    const p = PRICING[m];
    push(
      `| \`${m}\` | $${p.inputPerMTok.toFixed(2)} | $${p.outputPerMTok.toFixed(2)} | ${num(p.minCacheablePrefixTokens)} tok |`,
    );
  }
  push(
    "",
    "| Modifier | Value |",
    "|---|---|",
    "| Message Batches API | 50% off **both** input and output |",
    `| Cache read | ${CACHE_READ_MULTIPLIER}x base input |`,
    `| Cache write, 1h TTL | ${CACHE_WRITE_1H_MULTIPLIER}x base input |`,
    "| Cache write, 5m TTL | 1.25x base input |",
    "| Stacking | Cache multipliers stack with the Batch discount |",
    "",
    "Sources, all retrieved " + e.pricingVerifiedOn + ":",
    "",
    `- Pricing: ${PRICING_SOURCES.pricing}`,
    `- Batch API: ${PRICING_SOURCES.batch}`,
    `- Prompt caching: ${PRICING_SOURCES.caching}`,
    `- Token counting (free): ${PRICING_SOURCES.tokenCounting}`,
    "",
    "**Sonnet 5 pricing note.** $2/$10 was announced as introductory pricing",
    "through 2026-08-31; the docs now state that this is the standard price and",
    "the scheduled increase to $3/$15 on 2026-09-01 **will not occur**. The",
    "repo's `packages/agent/src/pricing.ts` still carries the stale note",
    '"Introductory pricing through 2026-08-31; re-verify after". The rate is',
    "correct, the note is not. Flagged for a separate fix; spec 09 §5 asks the",
    "report page to display the expiry while relevant, and it is no longer",
    "relevant.",
    "",
    "**Prompt caching inside the Batch API: verified, with a caveat.** Caching",
    "does work in batches and the discounts stack, but the docs state cache",
    'hits there are *"provided on a best-effort basis"*, with observed hit',
    "rates of **30% to 98%**. That range is why the cached column below is a",
    "band, not a point. The docs also recommend the 1h TTL for batch work",
    "(batches can outlive the 5-minute cache), so a cache **miss** is priced",
    `here as a ${CACHE_WRITE_1H_MULTIPLIER}x write rather than plain input.`,
    "",
    "---",
    "",
    "## 5. Matrix cost by model and cache mode",
    "",
    "All matrix runs via the Batch API (50% off). " +
      e.caseCount +
      " cases per",
    "model per column.",
    "",
    "### Uncached column",
    "",
    "| Model | Input $ | Output $ | Total | Cost/run |",
    "|---|---:|---:|---:|---:|",
  );
  for (const c of e.matrix.uncached) {
    push(
      `| \`${c.model}\` | ${usd4(c.inputCostUsd)} | ${usd4(c.outputCostUsd)} | **${usd4(c.totalUsd)}** | ${usd4(c.costPerRunUsd)} |`,
    );
  }
  push(
    `| **Subtotal** | | | **${usd(e.totals.matrixUncachedUsd)}** | |`,
    "",
    "### Cached column, by batch cache-hit rate",
    "",
    "| Hit rate | " +
      MATRIX_MODELS.map((m) => `\`${m}\``).join(" | ") +
      " | Subtotal |",
    "|---|" + MATRIX_MODELS.map(() => "---:").join("|") + "|---:|",
  );
  for (const h of CACHE_HIT_SCENARIOS) {
    const cells = e.matrix.cached[h.toFixed(2)];
    const subtotal = cells.reduce((a, c) => a + c.totalUsd, 0);
    push(
      `| ${(h * 100).toFixed(0)}% | ` +
        cells.map((c) => usd4(c.totalUsd)).join(" | ") +
        ` | **${usd(subtotal)}** |`,
    );
  }

  push(
    "",
    "### Effort axis",
    "",
    'Spec 09 §4 puts effort on the matrix "only where supported (not Haiku)"',
    "but does **not** enumerate which effort levels to sweep, so effort is",
    "carried here as a multiplier rather than as priced cells. A sweep of",
    "`{low, medium, high, xhigh}` on `claude-sonnet-5` and `claude-opus-5`",
    "multiplies those two models' matrix cost by roughly **4x on input** and",
    "**more than 4x on output** (higher effort spends more thinking and output",
    "tokens, and thinking is billed as output). Applying a conservative 4x to",
    "the Sonnet 5 + Opus 5 rows of the uncached column adds approximately",
    (() => {
      const rows = e.matrix.uncached.filter(
        (c) => c.model !== "claude-haiku-4-5",
      );
      const base = rows.reduce((a, c) => a + c.totalUsd, 0);
      return `**${usd(base * 3)}** on top of the uncached subtotal (4x = 3x incremental).`;
    })(),
    "Decide the effort levels before running; this line is not in the totals.",
    "",
    "---",
    "",
    "## 6. Judge and calibration",
    "",
    "The LLM judge grades the drafted-action text of each result (spec 09 §2).",
    "Cache mode does not change what the generator produces, so the cached and",
    "uncached cells of a given (case, model) share one judged result:",
    `${e.caseCount} cases x ${MATRIX_MODELS.length} models = ${num(e.caseCount * MATRIX_MODELS.length)} judged results.`,
    "Judge calls are assumed to run through the Batch API too (they are",
    "offline grading, not interactive).",
    "",
    "| Role | Judge model | Judged results | Input tok | Output tok | Cost |",
    "|---|---|---:|---:|---:|---:|",
  );
  for (const j of e.judge) {
    push(
      `| ${j.role} | \`${j.model}\` | ${num(j.judgedResults)} | ${num(j.inputTokens)} | ${num(j.outputTokens)} | ${usd4(j.totalUsd)} |`,
    );
  }
  push(
    `| **Subtotal** | | | | | **${usd(e.totals.judgeUsd)}** |`,
    "",
    "Both judges are budgeted: spec 09 §2 names `claude-sonnet-5` as the judge",
    "and `claude-opus-5` for the published run, so the matrix is judged twice.",
    "",
    "### Calibration (15 hand-scored holdouts)",
    "",
    "| Role | Judge model | Cases | Cost |",
    "|---|---|---:|---:|",
  );
  for (const c of e.calibration) {
    push(
      `| ${c.role} | \`${c.model}\` | ${c.judgedResults} | ${usd4(c.totalUsd)} |`,
    );
  }
  push(
    `| **Subtotal** | | | **${usd4(e.totals.calibrationUsd)}** |`,
    "",
    "---",
    "",
    "## 7. Interactive latency pass (non-batch)",
    "",
    'Spec 13 §3 requires interactive latency to be measured in "a separate',
    'small live pass" but does not fix its size. Sized here at',
    `${e.latencyPass.cases} cases x ${e.latencyPass.models} models x ${e.latencyPass.repetitions} repetitions = **${e.latencyPass.runs} runs**,`,
    "at full price (no batch discount) and uncached, conservative on every",
    "axis. Repetitions are what make p50/p95 meaningful.",
    "",
    "| Model | Cost |",
    "|---|---:|",
  );
  for (const m of e.latencyPass.perModelUsd) {
    push(`| \`${m.model}\` | ${usd4(m.totalUsd)} |`);
  }
  push(
    `| **Subtotal** | **${usd(e.latencyPass.totalUsd)}** |`,
    "",
    "---",
    "",
    "## 8. Totals",
    "",
    "| Component | Best case (98% hits) | Worst case (30% hits) |",
    "|---|---:|---:|",
    `| Matrix, uncached column | ${usd(e.totals.matrixUncachedUsd)} | ${usd(e.totals.matrixUncachedUsd)} |`,
    `| Matrix, cached column | ${usd(e.totals.matrixCachedBestUsd)} | ${usd(e.totals.matrixCachedWorstUsd)} |`,
    `| Judge (both judge models) | ${usd(e.totals.judgeUsd)} | ${usd(e.totals.judgeUsd)} |`,
    `| Judge calibration | ${usd(e.totals.calibrationUsd)} | ${usd(e.totals.calibrationUsd)} |`,
    `| Interactive latency pass | ${usd(e.totals.latencyUsd)} | ${usd(e.totals.latencyUsd)} |`,
    `| **Raw total** | **${usd(e.totals.rawUsdCachedBest)}** | **${usd(e.totals.rawUsd)}** |`,
    `| **With ${CONTINGENCY}x contingency** | **${usd(e.totals.withContingencyUsdCachedBest)}** | **${usd(e.totals.withContingencyUsd)}** |`,
    "",
    "Contingency covers: live models taking different tool paths than the",
    "deterministic mock (more iterations, extra `lookup_po` pages), schema",
    "retries on malformed `draft_action` inputs, batch requests that error and",
    "are resubmitted, and reruns after a threshold miss.",
    "",
    "---",
    "",
    "## 9. Assumptions, ordered by how much they move the number",
    "",
    "**A1. Live tool paths match the recorded cassettes.** Iteration count is",
    "the single biggest driver of input cost, because the whole prefix is",
    "re-read every turn. The cassettes come from the deterministic mock lane;",
    "a live model that pages the PO list, retries a schema, or re-reads policy",
    "adds a full conversation re-read per extra turn. The 1.3x contingency is",
    "sized primarily for this.",
    "",
    "**A2. Cache-hit rate inside the Batch API.** Documented as best-effort at",
    "30-98%. The spread between those two ends is the difference between the",
    "best- and worst-case totals above.",
    "",
    "**A3. One tool call per turn.** The estimator builds one turn per recorded",
    "tool call. If the live model batches parallel tool calls into one",
    "assistant turn, iterations drop and the bill drops with them; this",
    "assumption is conservative (biases the estimate high).",
    "",
    "**A4. Output tokens per iteration.** `tool_use` block sizes are measured;",
    "the surrounding preamble sentence is assumed constant. A chattier model",
    "moves output cost, which matters most on Opus 5 at $25/MTok.",
    "",
    "**A5. Judge runs once per (case, model), through the Batch API.** If the",
    "judge is instead run per matrix cell (cached and uncached separately) the",
    "judge subtotal doubles; if run interactively rather than batched it",
    "doubles again.",
    "",
    "**A6. No thinking tokens.** The loop sets no `thinking` parameter and the",
    "production model is `claude-haiku-4-5`. On Claude Opus 5 and Claude Sonnet",
    "5, adaptive thinking is **on by default** when the parameter is omitted,",
    "and thinking tokens bill as output. The Sonnet 5 and Opus 5 matrix rows",
    "are therefore a floor unless the runner explicitly sets",
    '`thinking: {type: "disabled"}` at effort `high` or below. Resolve this',
    "before running the matrix.",
    "",
    "**A7. Latency-pass sizing** (12 cases x 3 models x 3 reps) is chosen here,",
    "not specified. It is a small share of the total; changing it changes the",
    "total roughly linearly within that share.",
    "",
    "---",
    "",
    "## 10. Side findings (not cost, but they block the run)",
    "",
    "These came out of reconstructing the real payloads and should be settled",
    "before LOT-105 executes.",
    "",
    ...(meta.casesOverCap.length > 0
      ? [
          `**F1. ${meta.casesOverCap.length} cases exceed the ${meta.iterationCap}-iteration loop cap.**`,
          "A recorded sequence of N tool calls needs N+1 model turns (the final",
          "turn writes the answer). These cases need more turns than",
          "`MAX_ITERATIONS` allows:",
          "",
          "| Case | Model turns required | Cap |",
          "|---|---:|---:|",
          ...meta.casesOverCap.map(
            (c) => `| \`${c.caseId}\` | ${c.turns} | ${meta.iterationCap} |`,
          ),
          "",
          "In a live run the loop stops at the cap and those cases end without a",
          "final answer, a guaranteed failure that would read as a model",
          "capability result on the report page. Either raise `MAX_ITERATIONS`",
          "in `packages/agent/src/policy-constants.ts` (it is spec 13 §1's",
          "[DEFAULT] of 8, so an Abhinav-approved change), or rely on the live",
          "model issuing parallel tool calls to collapse turns, which is",
          "plausible but not something to bet a published number on. Their cost",
          "in this estimate is measured at their full sequence length, so the",
          "dollar figure is unaffected by which way this goes.",
          "",
        ]
      : []),
    ...(() => {
      const cap = 0.02; // MAX_RUN_COST_USD, spec 13 §1
      const rows = e.aggregates.map((a) => {
        const p = PRICING[a.model];
        const costUsd =
          (a.meanInputTokensPerRun * p.inputPerMTok +
            a.meanOutputTokensPerRun * p.outputPerMTok) /
          1_000_000;
        return { model: a.model, costUsd, overCap: costUsd > cap };
      });
      const breaching = rows.filter((r) => r.overCap);
      if (breaching.length === 0) return [];
      return [
        "**F2. Measured per-run cost breaches `MAX_RUN_COST_USD`.** The",
        "interactive (non-batch, uncached) cost of a single run, computed from",
        "the same measured token counts:",
        "",
        "| Model | Cost per interactive run | vs $0.02 per-run cap |",
        "|---|---:|---|",
        ...rows.map(
          (r) =>
            `| \`${r.model}\` | ${usd4(r.costUsd)} | ${r.overCap ? `**over by ${usd4(r.costUsd - cap)}**` : "under"} |`,
        ),
        "",
        "`claude-haiku-4-5` is the **public runtime model** (spec 13 preamble),",
        `and at ${usd4(rows[0].costUsd)} per run it sits above the $0.02`,
        "`MAX_RUN_COST_MICRO_USD` breaker in",
        "`packages/agent/src/policy-constants.ts`. Unchanged, the breaker aborts",
        'runs with `run.end{outcome:"cost_capped"}`, on the happy path, in',
        "front of a buyer. Prompt caching does not rescue it either: the",
        "cacheable prefix is 3,162 tokens against Haiku's 4,096-token minimum",
        "(see §3), so `cache_control` is silently ignored on exactly the model",
        "that needs it.",
        "",
        "Three ways out, in order of preference:",
        "",
        "1. **Get the Haiku prefix over 4,096 tokens** so caching engages. It is",
        "   934 tokens short. Cached, the per-run cost falls to roughly the",
        "   suffix-only figure and lands well under the cap. This is the only",
        "   option that improves the demo rather than loosening a control.",
        "2. **Raise `MAX_RUN_COST_USD`** to ~$0.05. It is a spec 13 §1 [DEFAULT],",
        "   so an Abhinav decision, and it interacts with the $1.00/day breaker:",
        "   at $0.032/run the daily budget already buys only ~31 runs.",
        "3. **Cut turns.** 6.84 model turns per run, each re-reading the whole",
        "   prefix, is what drives the cost. Parallel tool calls would collapse",
        "   several turns into one.",
        "",
        "This is a containment finding, not a matrix-cost finding (the batch",
        "matrix is unaffected), but it blocks the public demo and should be",
        "settled alongside the spend approval.",
        "",
      ];
    })(),
    "**F3. Stale pricing note in the repo.** `packages/agent/src/pricing.ts`",
    'carries `note: "Introductory pricing through 2026-08-31; re-verify after"`',
    "on the `claude-sonnet-5` entry. The rate ($2/$10) is correct, but the",
    "docs now state it is the standard price and the increase will not happen.",
    'Spec 09 §5 asks the report page to show that expiry "while relevant"; it',
    "no longer is. One-line fix, outside this workpaper's scope.",
    "",
    "**F4. Thinking defaults differ across the matrix.** The loop sets no",
    "`thinking` parameter. That means no thinking on `claude-haiku-4-5`, but",
    "adaptive thinking **on by default** for `claude-sonnet-5` and",
    "`claude-opus-5`. Unaddressed, the matrix compares a non-thinking Haiku",
    "against two thinking models, and the Sonnet/Opus cost rows here are a",
    "floor. Decide explicitly before running.",
    "",
    "---",
    "",
    "## 11. Reproducing this",
    "",
    "```sh",
    "set -a; . ~/dev/lotus/demos/secrets/backoffice-runtime.env; set +a",
    "npx vitest run --config evals/runner/src/spend/vitest.scripts.config.ts",
    "```",
    "",
    "The estimator lives in `evals/runner/src/spend/` and is excluded from the",
    "root vitest config (which includes `*.test.ts` only), so a normal",
    "`npm test` never contacts the API. Machine-readable output:",
    "`evals/spend-estimate-2026-08-11.json`.",
    "",
    "— L. Fox (Systems Architect)",
    "",
  );

  return L.join("\n");
}
