# LOT-105 live matrix: handoff

Written 2026-08-12 by the LOT-105 agent, mid-run, for whoever finishes it.
Read this instead of the thread.

## State at handoff

- **Run is live and unattended.** `npx vitest run --config evals/runner/src/matrix/vitest.scripts.config.ts run.script`, launched under `nohup`, log at `/tmp/matrix-full5.log`.
- **Ledger:** `evals/results/spend-ledger-2026-08-11.json`, total **$6.2202** over 1,725 entries, against a **$65 hard stop** and a **$55 report line**.
- **Lanes complete and checkpointed:** `claude-haiku-4-5:uncached`, `claude-haiku-4-5:cached`. Their checkpoints are in this directory and a resumed run skips them at zero cost.
- **Lanes remaining:** `claude-sonnet-5:uncached` (in progress), `claude-sonnet-5:cached`, `claude-opus-5:uncached`, `claude-opus-5:cached`, then both judge passes, then the interactive latency pass.
- **On completion** the run writes `matrix.json`, `lane-*.json`, `latency.json`, `README.md`, `calibration-worksheet.md` and `calibration-key.json` into this directory.

## The run does not need a human

- **Spend is enforced in-process.** `ledger.assertHeadroom()` runs before every submission and throws rather than crossing $65. The ledger is written through on every retrieval, so a crash leaves a truthful file.
- **Lanes checkpoint themselves** the moment they complete, and a lane failure is isolated: it is recorded as a note and the remaining lanes continue.
- **Judge and latency failures are isolated too.** Either can fail without discarding lane results; the README says so.
- **Stalled batches** are cancelled and resubmitted after 45 minutes, bounded at 3 retries, then the lane fails loudly.

## How to tell the run is healthy

**Watch the ledger, not `request_counts`.** Batch counts stay at zero for a
batch's whole life and then jump to final, so they tell you nothing while a
batch is in flight. The signal that matters is `totals.cost_usd` and
`totals.entries` in `evals/results/spend-ledger-2026-08-11.json` moving as
rounds land:

```sh
watch -n 60 "python3 -c \"import json;t=json.load(open('evals/results/spend-ledger-2026-08-11.json'))['totals'];print(t['cost_usd'],t['entries'])\""
```

A **flat ledger while batches keep ending is an alarm**, not a quiet period.
That exact condition is what a bad stall heuristic looked like from the
outside for about an hour before I recognised it, and it is the cheapest
health check available. Rounds should add tens of entries at a time.

Resubmission is now a **rare backstop**: 45 minutes of elapsed wall clock with
no `ended` status, bounded at 3 attempts. If you see resubmissions happening
routinely rather than occasionally, something is wrong again; do not raise the
retry count to paper over it.

## To finish

```sh
# 1. Wait for matrix.json to appear in this directory.
# 2. Sweep any billed-but-unread results into the ledger, then add the
#    cache-cadence table and the spend reconciliation to matrix.json + README.
MATRIX_SWEEP=1 SUPERSEDED_BEFORE=<ISO timestamp of the first restart> \
  npm run -w @novagait/evals-runner matrix:augment
```

`MATRIX_SWEEP=1` re-reads every ended batch and records any billed result the
driver never read (see "corrections" below for why those exist). Without it
the ledger under-reports real spend. `SUPERSEDED_BEFORE` marks the abandoned
first attempt so its spend is itemised rather than folded into the published
total. The augment step **asserts the reconciliation balances** and fails
loudly if it does not.

Then: verify the gates in `README.md`, commit `evals/results/**`, and hand the
blinded worksheet to Abhinav. Calibration agreement is computed in a later
pass from his hand scores; it is deliberately not in this run.

## Open items

1. Judge passes (working + published) and the interactive latency pass.
2. `matrix:augment` with the sweep, and confirming the reconciliation assertion passes.
3. Gate verdicts read off the deployed tier (`claude-haiku-4-5`); other tiers are informational.
4. Commit results; deliver `calibration-worksheet.md` to Abhinav for hand scoring.
5. Post-matrix cleanup items filed against LOT-120 (not this ticket).

## Provenance that must survive into the published README

These are measured facts about how the matrix was produced. They belong in the
published notes, not just in this file.

- **Stuck-batch handling.** Batch `request_counts` are **not** a progress
  signal: a batch reports zero completions for its whole run and then jumps to
  final counts. The harness therefore times out on elapsed wall clock (45 min)
  and treats resubmission as a rare-event backstop. Control measurement worth
  quoting: fresh batches of 2 and 8 large requests both ended in **2.3
  minutes** while four of the run's own chunks, submitted 25 minutes earlier,
  still showed zero.
- **Short-circuit savings.** 5 of 73 golden cases are rejected by the pre-model
  GR-SCOPE screen and never cost a request. Every round batches 68, not 73.
- **Cache economics on the deployed tier.** Caching cut the haiku lane cost by
  roughly 40%, with 138K cache-read tokens against 147K written on the first
  cached round. This is the headline economics number.
- **Redo accounting.** The haiku lanes were run twice; the abandoned attempt's
  spend is real and is itemised separately by `reconcileSpend` rather than
  folded into the published total.
- **Metric caveats** from `evals/thresholds.json` (`vendor_id_field_accuracy`
  degenerate, `output_schema_valid` reduced to drafted/not-drafted, graded
  `decision` is the DISPOSED route). Already wired into the README.
- **Reviewer N3.** A live model that resolves more vendors than the mock
  planner emits extra `lookup_vendor` and `memory.read` events. That is correct
  behaviour: grading fails only on MISSING required calls or `must_not_call`
  violations, so a higher tool count is not a penalty.
- **Cached-column honesty rule.** If a lane's round cadence exceeds the 1h TTL,
  its cached column inverts and costs more than uncached. `cacheStatsByLane`
  measures this per round; publish the inversion as a finding with its numbers
  rather than relabelling or suppressing it.

## Corrections the finisher must not inherit

I was wrong three times tonight, in the same shape each time: took a signal I
did not understand, built a mechanism from it, acted. Do not inherit the
earlier optimism from the thread.

1. **"General congestion" was wrong.** A control probe overturned it.
2. **"Batch size is the variable, chunking fixes it" was wrong.** A controlled
   probe (2 and 8 large requests versus 2 and 16 small, submitted together)
   showed size was not the variable. **Chunking did not buy back the scope.**
   It stays at 16 per batch only because a stuck batch then strands less work.
3. **The first stall heuristic was actively harmful.** It keyed on zero
   completions, which is what healthy batches look like, so it cancelled
   batches mid-flight: repeatedly `succeeded: 13, canceled: 3`, billing 13
   requests whose results were discarded, while the ledger sat flat. Fixed to
   elapsed-time-only at 45 minutes.

   **Assume some of those cancels killed healthy batches.** The 72-minute
   batch that started the whole investigation was cancelled by me before it
   could finish, so it may have been slow rather than stuck; several 16-request
   chunks demonstrably were about to complete when they were cancelled. The
   `unrecorded:swept` ledger lines that `MATRIX_SWEEP=1` produces ARE the
   honest accounting of that: money spent on requests that completed and were
   billed but whose results the driver never read. Publish them as such rather
   than netting them out, and do not describe those batches as "stuck" in the
   README when "cancelled by an incorrect heuristic" is what actually
   happened.

What is actually carrying the run: **checkpoints, lane isolation, and
elapsed-time stall retry**. Not chunking.

The durable lesson, worth keeping: probe with a **control**, and treat a
flat ledger during active batches as a first-class alarm rather than a number
that happens not to move.

## Scope

Full six lanes, per Abhinav's approval. A pre-authorized fallback to four lanes
(both haiku + `sonnet:uncached` + `opus:uncached`) is armed and fires only on
measurement: if round cadence exceeds the 1h cache TTL so the comparison-tier
cached lanes invert, or if projected completion threatens the API's 24h batch
expiry. If it fires, publish the gap explicitly with the congestion
measurements and note it was a pre-authorized fallback.

— L. Fox (Systems Architect)
