> **Addendum: post-LOT-119 re-measurement.**
>
> Measured 2026-08-11, after LOT-119 (`PROMPT_VERSION` 1.2.0, system+tools
> prefix 4,516 tokens on `claude-haiku-4-5`, prompt caching wired into both
> loop drivers). This supersedes the token and dollar figures in
> `spend-estimate-2026-08-11.md`, which were measured against
> `PROMPT_VERSION` 1.1.0 and a 3,162-token prefix.
>
> **Totals:** raw **$49.81** worst / **$35.27** best; with 1.3x contingency
> **$64.75** worst / **$45.85** best. **Envelope approved: $65** (Abhinav,
> 2026-08-11).
>
> **Also decided on this evidence:** `MAX_RUN_COST_MICRO_USD` raised
> 20_000 -> 30_000 ($0.02 -> $0.03). The re-run measured 23 of 73 cached
> interactive Haiku runs above the old $0.02 breaker (mean $0.0183, worst
> $0.0239, led by the three 9-turn cases): caching more than halved the
> per-run cost but did not clear the tail.
>
> **Read the numbers, not the narrative.** The body below is generator
> output. Its §10 "side findings" prose was written against the pre-LOT-119
> state and parts of it are stale where they describe the prefix as 3,162
> tokens / 934 short of the minimum, `cache_control` as silently ignored, or
> `MAX_ITERATIONS` as 8. The generator (`evals/runner/src/spend/report.ts`)
> was fixed in the same commit as this file to derive those statements from
> the measured prefix and the live policy constants, so the next regeneration
> will read correctly; this document is the output as generated, kept as the
> dated record of the measurement.

---

# LOT-105 live eval matrix: spend estimate (workpaper)

Generated post-lot119. Pricing verified 2026-08-11.
Prompt version 1.2.0, tools version 1.0.0.

S9 gate artifact: the dollar figure that must be shown to Abhinav before
any live run (spec 09 §4, spec 13 §3).

**Zero live spend was incurred producing this document.** Every token
count below came from `messages.count_tokens` (3,363 calls),
which the docs state is free to use. No call to `messages.create` or any
token-consuming endpoint was made.

---

## 1. Headline

| Line                                  |        Raw | With 1.3x contingency |
| ------------------------------------- | ---------: | --------------------: |
| Best case (98% batch cache-hit rate)  | **$35.27** |            **$45.85** |
| Worst case (30% batch cache-hit rate) | **$49.81** |            **$64.75** |

The matrix ships **both** cache columns (spec 09 §4 publishes cached and
uncached side by side), so the headline is the sum of the two columns
plus judge, calibration, and the interactive latency pass, not one
column or the other.

---

## 2. Method

1. **Base payload, measured not modelled.** For each of the
   73 golden cases the estimator reconstructs the first live
   request exactly as `packages/agent/src/loop.ts` would send it: the
   frozen system prompt from `prompts.ts` (PROMPT_VERSION
   1.2.0), all 8 tool JSON Schemas built the same way the
   raw driver builds them (`z.toJSONSchema(toolInputSchemas[name])`), and
   an intake user turn carrying the inbox-item metadata plus the document
   body from the compiled fixtures. That payload goes to `count_tokens`.
2. **Multi-turn growth, measured from the cassettes.** Each cassette in
   `evals/cassettes/INV-*.json` records the case's actual `tool_calls`
   sequence. The estimator replays that sequence, building one turn per
   call: an assistant message (short preamble + `tool_use` block with the
   real input the model would emit) and a user message carrying the real
   tool result, produced by invoking the deterministic mock backend
   (`getVendor`, `getPurchaseOrder`, `getReceivingForPo`, `invoiceExists`,
   `searchKb`). The conversation is counted **at every iteration**, because
   the API re-reads the whole prefix each turn; billed input is the sum of
   those per-iteration counts, not the final conversation length.
3. **Output tokens, measured per iteration.** For each turn the estimator
   counts the conversation with the assistant message appended and
   subtracts the conversation without it. That prices the `tool_use`
   blocks exactly, including `draft_action`, which carries the full
   extraction with source spans and dominates output on every case.
4. **Per-model tokenisation.** Every count is taken separately against
   `claude-haiku-4-5`, `claude-sonnet-5`, and `claude-opus-5`; these models
   do not share a tokenizer, so a single count reused across the matrix
   would be wrong.

### Output-token assumption (the one modelled quantity)

Per-iteration output = measured `tool_use` block size + a short preamble
sentence, held constant at: "I'll resolve the vendor and the referenced purchase order before deciding."

The final turn is a measured sample of a closing summary. Everything else
in the output column is measured, not assumed. Thinking tokens are **not**
included: the agent runs on `claude-haiku-4-5` in production and the loop
sets no `thinking` parameter; see Assumption A6 for the exposure on the
Sonnet 5 and Opus 5 rows, where thinking is on by default.

---

## 3. Measured token tables

Per model, summed across all 73 cases (one run each):

| Model              | Cacheable prefix (sys+tools) | Mean iterations/run | Mean input tok/run | Mean output tok/run | Total input tok | Total output tok |
| ------------------ | ---------------------------: | ------------------: | -----------------: | ------------------: | --------------: | ---------------: |
| `claude-haiku-4-5` |                        4,516 |                 6.8 |             36,240 |                 924 |       2,645,541 |           67,444 |
| `claude-sonnet-5`  |                        5,845 |                 6.8 |             46,811 |               1,097 |       3,417,221 |           80,059 |
| `claude-opus-5`    |                        5,777 |                 6.8 |             46,346 |               1,097 |       3,383,289 |           80,059 |

Input split into the shared cacheable prefix (re-read once per iteration)
and the per-case suffix that can never be shared:

| Model              | Total prefix tok (re-reads) | Total suffix tok | Prefix share of input |
| ------------------ | --------------------------: | ---------------: | --------------------: |
| `claude-haiku-4-5` |                   2,253,484 |          392,057 |                 85.2% |
| `claude-sonnet-5`  |                   2,916,655 |          500,566 |                 85.4% |
| `claude-opus-5`    |                   2,882,723 |          500,566 |                 85.2% |

---

## 4. Pricing table (verified 2026-08-11)

| Model              | Input $/MTok | Output $/MTok | Min cacheable prefix |
| ------------------ | -----------: | ------------: | -------------------: |
| `claude-haiku-4-5` |        $1.00 |         $5.00 |            4,096 tok |
| `claude-sonnet-5`  |        $2.00 |        $10.00 |            1,024 tok |
| `claude-opus-5`    |        $5.00 |        $25.00 |              512 tok |

| Modifier            | Value                                           |
| ------------------- | ----------------------------------------------- |
| Message Batches API | 50% off **both** input and output               |
| Cache read          | 0.1x base input                                 |
| Cache write, 1h TTL | 2x base input                                   |
| Cache write, 5m TTL | 1.25x base input                                |
| Stacking            | Cache multipliers stack with the Batch discount |

Sources, all retrieved 2026-08-11:

- Pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Batch API: https://platform.claude.com/docs/en/build-with-claude/batch-processing
- Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Token counting (free): https://platform.claude.com/docs/en/build-with-claude/token-counting

**Sonnet 5 pricing note.** $2/$10 was announced as introductory pricing
through 2026-08-31; the docs now state that this is the standard price and
the scheduled increase to $3/$15 on 2026-09-01 **will not occur**. The
repo's `packages/agent/src/pricing.ts` still carries the stale note
"Introductory pricing through 2026-08-31; re-verify after". The rate is
correct, the note is not. Flagged for a separate fix; spec 09 §5 asks the
report page to display the expiry while relevant, and it is no longer
relevant.

**Prompt caching inside the Batch API: verified, with a caveat.** Caching
does work in batches and the discounts stack, but the docs state cache
hits there are _"provided on a best-effort basis"_, with observed hit
rates of **30% to 98%**. That range is why the cached column below is a
band, not a point. The docs also recommend the 1h TTL for batch work
(batches can outlive the 5-minute cache), so a cache **miss** is priced
here as a 2x write rather than plain input.

---

## 5. Matrix cost by model and cache mode

All matrix runs via the Batch API (50% off). 73 cases per
model per column.

### Uncached column

| Model              | Input $ | Output $ |       Total | Cost/run |
| ------------------ | ------: | -------: | ----------: | -------: |
| `claude-haiku-4-5` | $1.3228 |  $0.1686 | **$1.4914** |  $0.0204 |
| `claude-sonnet-5`  | $3.4172 |  $0.4003 | **$3.8175** |  $0.0523 |
| `claude-opus-5`    | $8.4582 |  $1.0007 | **$9.4590** |  $0.1296 |
| **Subtotal**       |         |          |  **$14.77** |          |

### Cached column, by batch cache-hit rate

| Hit rate | `claude-haiku-4-5` | `claude-sonnet-5` | `claude-opus-5` |   Subtotal |
| -------- | -----------------: | ----------------: | --------------: | ---------: |
| 98%      |            $0.5201 |           $1.3034 |         $3.2467 |  **$5.07** |
| 90%      |            $0.6914 |           $1.7467 |         $4.3421 |  **$6.78** |
| 70%      |            $1.1196 |           $2.8550 |         $7.0807 | **$11.06** |
| 30%      |            $1.9759 |           $5.0717 |        $12.5579 | **$19.61** |

### Effort axis

Spec 09 §4 puts effort on the matrix "only where supported (not Haiku)"
but does **not** enumerate which effort levels to sweep, so effort is
carried here as a multiplier rather than as priced cells. A sweep of
`{low, medium, high, xhigh}` on `claude-sonnet-5` and `claude-opus-5`
multiplies those two models' matrix cost by roughly **4x on input** and
**more than 4x on output** (higher effort spends more thinking and output
tokens, and thinking is billed as output). Applying a conservative 4x to
the Sonnet 5 + Opus 5 rows of the uncached column adds approximately
**$39.83** on top of the uncached subtotal (4x = 3x incremental).
Decide the effort levels before running; this line is not in the totals.

---

## 6. Judge and calibration

The LLM judge grades the drafted-action text of each result (spec 09 §2).
Cache mode does not change what the generator produces, so the cached and
uncached cells of a given (case, model) share one judged result:
73 cases x 3 models = 219 judged results.
Judge calls are assumed to run through the Batch API too (they are
offline grading, not interactive).

| Role         | Judge model       | Judged results | Input tok | Output tok |      Cost |
| ------------ | ----------------- | -------------: | --------: | ---------: | --------: |
| working      | `claude-sonnet-5` |            219 |    71,859 |     31,974 |   $0.2317 |
| published    | `claude-opus-5`   |            219 |    71,859 |     31,974 |   $0.5793 |
| **Subtotal** |                   |                |           |            | **$0.81** |

Both judges are budgeted: spec 09 §2 names `claude-sonnet-5` as the judge
and `claude-opus-5` for the published run, so the matrix is judged twice.

### Calibration (15 hand-scored holdouts)

| Role         | Judge model       | Cases |        Cost |
| ------------ | ----------------- | ----: | ----------: |
| working      | `claude-sonnet-5` |    15 |     $0.0159 |
| published    | `claude-opus-5`   |    15 |     $0.0397 |
| **Subtotal** |                   |       | **$0.0556** |

---

## 7. Interactive latency pass (non-batch)

Spec 13 §3 requires interactive latency to be measured in "a separate
small live pass" but does not fix its size. Sized here at
12 cases x 3 models x 3 repetitions = **108 runs**,
at full price (no batch discount) and uncached, conservative on every
axis. Repetitions are what make p50/p95 meaningful.

| Model              |       Cost |
| ------------------ | ---------: |
| `claude-haiku-4-5` |    $1.4710 |
| `claude-sonnet-5`  |    $3.7652 |
| `claude-opus-5`    |    $9.3294 |
| **Subtotal**       | **$14.57** |

---

## 8. Totals

| Component                 | Best case (98% hits) | Worst case (30% hits) |
| ------------------------- | -------------------: | --------------------: |
| Matrix, uncached column   |               $14.77 |                $14.77 |
| Matrix, cached column     |                $5.07 |                $19.61 |
| Judge (both judge models) |                $0.81 |                 $0.81 |
| Judge calibration         |                $0.06 |                 $0.06 |
| Interactive latency pass  |               $14.57 |                $14.57 |
| **Raw total**             |           **$35.27** |            **$49.81** |
| **With 1.3x contingency** |           **$45.85** |            **$64.75** |

Contingency covers: live models taking different tool paths than the
deterministic mock (more iterations, extra `lookup_po` pages), schema
retries on malformed `draft_action` inputs, batch requests that error and
are resubmitted, and reruns after a threshold miss.

---

## 9. Assumptions, ordered by how much they move the number

**A1. Live tool paths match the recorded cassettes.** Iteration count is
the single biggest driver of input cost, because the whole prefix is
re-read every turn. The cassettes come from the deterministic mock lane;
a live model that pages the PO list, retries a schema, or re-reads policy
adds a full conversation re-read per extra turn. The 1.3x contingency is
sized primarily for this.

**A2. Cache-hit rate inside the Batch API.** Documented as best-effort at
30-98%. The spread between those two ends is the difference between the
best- and worst-case totals above.

**A3. One tool call per turn.** The estimator builds one turn per recorded
tool call. If the live model batches parallel tool calls into one
assistant turn, iterations drop and the bill drops with them; this
assumption is conservative (biases the estimate high).

**A4. Output tokens per iteration.** `tool_use` block sizes are measured;
the surrounding preamble sentence is assumed constant. A chattier model
moves output cost, which matters most on Opus 5 at $25/MTok.

**A5. Judge runs once per (case, model), through the Batch API.** If the
judge is instead run per matrix cell (cached and uncached separately) the
judge subtotal doubles; if run interactively rather than batched it
doubles again.

**A6. No thinking tokens.** The loop sets no `thinking` parameter and the
production model is `claude-haiku-4-5`. On Claude Opus 5 and Claude Sonnet
5, adaptive thinking is **on by default** when the parameter is omitted,
and thinking tokens bill as output. The Sonnet 5 and Opus 5 matrix rows
are therefore a floor unless the runner explicitly sets
`thinking: {type: "disabled"}` at effort `high` or below. Resolve this
before running the matrix.

**A7. Latency-pass sizing** (12 cases x 3 models x 3 reps) is chosen here,
not specified. It is a small share of the total; changing it changes the
total roughly linearly within that share.

---

## 10. Side findings (not cost, but they block the run)

These came out of reconstructing the real payloads and should be settled
before LOT-105 executes.

**F2. Measured per-run cost breaches `MAX_RUN_COST_USD`.** The
interactive (non-batch, uncached) cost of a single run, computed from
the same measured token counts:

| Model              | Cost per interactive run | vs $0.02 per-run cap |
| ------------------ | -----------------------: | -------------------- |
| `claude-haiku-4-5` |                  $0.0409 | **over by $0.0209**  |
| `claude-sonnet-5`  |                  $0.1046 | **over by $0.0846**  |
| `claude-opus-5`    |                  $0.2591 | **over by $0.2391**  |

`claude-haiku-4-5` is the **public runtime model** (spec 13 preamble),
and at $0.0409 per run it sits above the $0.02
`MAX_RUN_COST_MICRO_USD` breaker in
`packages/agent/src/policy-constants.ts`. Unchanged, the breaker aborts
runs with `run.end{outcome:"cost_capped"}`, on the happy path, in
front of a buyer. Prompt caching does not rescue it either: the
cacheable prefix is 3,162 tokens against Haiku's 4,096-token minimum
(see §3), so `cache_control` is silently ignored on exactly the model
that needs it.

Three ways out, in order of preference:

1. **Get the Haiku prefix over 4,096 tokens** so caching engages. It is
   934 tokens short. Cached, the per-run cost falls to roughly the
   suffix-only figure and lands well under the cap. This is the only
   option that improves the demo rather than loosening a control.
2. **Raise `MAX_RUN_COST_USD`** to ~$0.05. It is a spec 13 §1 [DEFAULT],
   so an Abhinav decision, and it interacts with the $1.00/day breaker:
   at $0.032/run the daily budget already buys only ~31 runs.
3. **Cut turns.** 6.84 model turns per run, each re-reading the whole
   prefix, is what drives the cost. Parallel tool calls would collapse
   several turns into one.

This is a containment finding, not a matrix-cost finding (the batch
matrix is unaffected), but it blocks the public demo and should be
settled alongside the spend approval.

**F3. Stale pricing note in the repo.** `packages/agent/src/pricing.ts`
carries `note: "Introductory pricing through 2026-08-31; re-verify after"`
on the `claude-sonnet-5` entry. The rate ($2/$10) is correct, but the
docs now state it is the standard price and the increase will not happen.
Spec 09 §5 asks the report page to show that expiry "while relevant"; it
no longer is. One-line fix, outside this workpaper's scope.

**F4. Thinking defaults differ across the matrix.** The loop sets no
`thinking` parameter. That means no thinking on `claude-haiku-4-5`, but
adaptive thinking **on by default** for `claude-sonnet-5` and
`claude-opus-5`. Unaddressed, the matrix compares a non-thinking Haiku
against two thinking models, and the Sonnet/Opus cost rows here are a
floor. Decide explicitly before running.

---

## 11. Reproducing this

```sh
set -a; . ~/dev/lotus/demos/secrets/backoffice-runtime.env; set +a
npx vitest run --config evals/runner/src/spend/vitest.scripts.config.ts
```

The estimator lives in `evals/runner/src/spend/` and is excluded from the
root vitest config (which includes `*.test.ts` only), so a normal
`npm test` never contacts the API. Machine-readable output:
`evals/spend-estimate-2026-08-11.json`.

— L. Fox (Systems Architect)
