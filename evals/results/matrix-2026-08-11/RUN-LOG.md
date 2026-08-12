# LOT-105 live matrix: run log

What actually happened while these artifacts were produced, including the
lanes that are absent and why. `README.md` and `matrix.json` are regenerated
by the driver on every invocation; this file is written by hand and is not.

**This run is INCOMPLETE and is not a release verdict.** It stopped on an
external blocker, not on a decision that the matrix was finished.

## What is published

Three of six lanes, all resumed from checkpoints written before the stop:

| lane | status |
| --- | --- |
| `claude-haiku-4-5:uncached` | complete, published |
| `claude-haiku-4-5:cached` | complete, published |
| `claude-opus-5:uncached` | complete, published |
| `claude-sonnet-5:uncached` | ABSENT, see incidents 3 and 10 |
| `claude-sonnet-5:cached` | ABSENT, see incidents 3 and 10 |
| `claude-opus-5:cached` | ABSENT, see incidents 4 and 10 (attempted twice) |

Also absent: both judge passes, the interactive latency pass, and therefore
every p50/p95 figure and every judge verdict. `latency.json` is empty by
construction, not by measurement.

## Incidents

1. **The harness's own clock killed a paid run.** The matrix entrypoint runs
   as a vitest test, so vitest's `testTimeout` was a second, invisible deadline
   layered over a checkpointed paid run. It fired at 8h and killed the run
   mid-lane with a 16-request opus batch in flight, billed and never read.
   Fixed by removing the timeout (`vitest.scripts.config.ts`); the real bounds
   are the ledger hard stop, the per-batch max wait, and the API's own 24h
   batch expiry.

2. **`MATRIX_SWEEP` could not price anything.** A batch result echoes the
   resolved dated snapshot (`claude-haiku-4-5-20251001`) while the pricing
   table is keyed by alias, so the sweep threw before recording a single
   entry, losing exactly the billed-but-unread spend it exists to recover.
   Fixed by resolving an 8-digit date suffix to the alias. Recovered $1.4713
   across 201 results on the first successful sweep.

3. **Both sonnet lanes failed, and the stall threshold is why.** The driver
   cancelled and resubmitted any batch that had not ended within 45 minutes,
   bounded at 4 attempts. Measured on 2026-08-12: haiku and opus batches of 16
   requests ended in 2 to 3 minutes, but two sonnet-5 batches of the same shape
   took 2.5 and 6 hours and ended with **all 16 requests succeeded**. The
   threshold sat inside sonnet's normal completion range, so it repeatedly
   cancelled healthy work and both lanes failed after exhausting their retries,
   consuming roughly 6 hours of the run's wall clock. This is the same class of
   error as the completion-count heuristic it replaced: a threshold set inside
   the range of normal behaviour. Stall timeout, retries and max wait are now
   per-invocation inputs rather than constants. The sonnet lanes were not
   re-attempted because of incident 4.

4. **The Anthropic account ran out of credits, which is what stopped the run.**
   The resumed `claude-opus-5:cached` lane completed its first 16-request chunk
   and then failed on submitting the second with
   `400 invalid_request_error: Your credit balance is too low to access the
   Anthropic API`. Confirmed independently: a 1-token haiku request fails with
   the same error. No further live work is possible until credits are added,
   which is a human decision and was not taken here. The lane's spend is real
   and is itemised as superseded.

5. **A lane-filtered invocation overwrote the matrix with an empty one.**
   Driving a single lane in its own invocation still writes `matrix.json` and
   `README.md` at the end, so when that lane failed the directory briefly held
   a matrix with zero lanes and zero rows. Regenerating from the surviving
   checkpoints costs nothing (checkpointed lanes are read from disk and no API
   call is made), and that is how the current artifacts were produced.

6. **Two of the four gates pass vacuously.** `evals/baseline/latest.json` does
   not exist, so `p0_no_regression` and `aggregate_no_drop` had nothing to
   compare against and reported pass. They are not evidence of no regression.
   The driver now says so in the published notes whenever the baseline is
   absent.

7. **The model-vs-policy divergence column published a fabricated zero.**
   All three lanes reported 0. The join read the model's proposed route from
   `modelRoutes`, an in-memory map that is only written when a case is RUN, and
   all three published lanes were resumed from checkpoints, so it joined
   against an empty map and rendered "nothing to compare" as "no divergence".
   Fixed on 2026-08-12: the proposal is persisted on `CaseRunRecord` so it
   survives a checkpoint, `laneDivergence()` returns **null rather than 0**
   when a lane has no captured proposals, and `matrix:backfill-routes`
   recovers the proposal for the already-published lanes from stored batch
   results at **zero spend**, asserting the recovered attempt's per-case
   request count against the checkpoint's own `iterations` so a superseded
   attempt (the haiku lanes ran twice) cannot be picked up silently.

   Recovery is trace-faithful, and getting that wrong inflated the number
   twice before it was tightened:
   - a `draft_action` truncated by the 2048-token output cap still exposes
     partially parsed arguments, but the driver never executes a truncated
     turn, so nothing is traced. Counting them invented 22 divergences on
     `claude-opus-5:uncached`.
   - INV-037 on `claude-haiku-4-5:uncached`: the model drafted `route=reject`,
     the arguments failed the tool schema, the executor answered `is_error`,
     and the run ended `held / no_draft_action`. Also never traced. That
     invented one more.

   Corrected and measured: `claude-haiku-4-5:uncached` **0** over 66 traced
   proposals, `claude-haiku-4-5:cached` **4** over 66,
   `claude-opus-5:uncached` **4** over 41. A worked example is INV-010, where
   the model asked for `auto_approve` and policy disposed `exception_hold`.

   **The GRD-004 failures are a different axis and are not route divergence.**
   On `claude-haiku-4-5:uncached`, 45 of the 45 cases that called
   `execute_action` on a non-`auto_approve` disposition had the model
   proposing exactly the route policy disposed. The model agrees about the
   route and reaches for the forbidden tool anyway. Both facts are true at
   once, and the divergence column does not measure the guardrail failure.

8. **Opus loses 27 of 73 runs to the output cap, not to reasoning.** On
   `claude-opus-5:uncached`, 27 runs ended `held / no_draft_action` with a
   final `stop_reason` of `max_tokens`: the model was still writing its
   `draft_action` when it hit `max_tokens: 2048`. That is why only 41 of its
   cases carry a traced proposal. The opus row's pass rate is in part an
   output-cap artifact and must not be read as a pure capability comparison.

9. **Credits were restored and verified before any further spend.** The
   account was topped up by the principal on 2026-08-12. `count_tokens` is
   free and proves nothing about billing, so verification was a single real
   8-input/1-output-token interactive request, recorded in the ledger as
   `credit-probe`.

10. **A workspace API usage limit ended the run, and it is a different
    blocker from the credit exhaustion.** Credits were topped up and verified
    on 2026-08-12 (incident 9), and `claude-opus-5:cached` was re-run from
    scratch. It completed rounds 0 and 1 (68 requests each) and failed on the
    next submission with `400 invalid_request_error: You have reached your
    specified workspace API usage limits. You will regain access on 2026-09-01
    at 00:00 UTC.` Confirmed independently: a 1-token haiku request fails the
    same way. **No further live measurement is possible on this workspace
    until 2026-09-01**, which is an account-configuration decision for the
    principal and was not taken here.

    Two consequences worth separating:
    - The lane's ~$1.00 of real spend is itemised as superseded, not netted
      out. Its results are billed and unread.
    - `claude-sonnet-5:uncached` and `claude-sonnet-5:cached` were never
      attempted. A control probe at 21:41Z had just shown sonnet batches
      ending in **3.1 minutes**, i.e. the multi-hour cadence of incident 3 was
      transient congestion and the lanes were feasible again. They are absent
      because the workspace limit landed first, NOT because of cadence.

    What made an honest close-out possible: **reads are still permitted**.
    Retrieving finished batch results, listing batches and sweeping
    billed-but-unread spend all still work, so the divergence recovery, the
    matrix regeneration from checkpoints and the reconciliation sweep were all
    completed after writes were blocked, at zero spend.

11. **Spend attribution moved from lane name to batch id, and it moved
    $3.1963.** `reconcileSpend` was told which spend was published by matching
    lane NAMES against the surviving matrix. That is wrong for any lane that
    ran more than once: the haiku lanes were each run twice, and re-running
    `claude-opus-5:cached` would have made the credit-exhausted attempt's
    spend look published because the name matched. Each lane's checkpoint now
    carries the batch ids of the attempt that was actually published, and
    those ids are the authority. The published figure fell from $15.8283 to
    $12.6320; the difference is the haiku lanes' superseded first attempts,
    which are now itemised as what they are.

## The finding that needs a human decision

Across all three published lanes the dominant failure is `GRD-004`,
`must_not_call: execute_action`: the live agent called the forbidden action
tool. On `claude-haiku-4-5:uncached` this is 29 of 41 failures, and it is what
fails the `guardrail_hard_zero` gate, whose threshold is zero.

This is measured, not inferred, and it reproduces on both models. It is
consistent across cache modes, which is expected: caching does not change what
the generator produced. Two readings are open and this run cannot settle
between them:

- the live agent genuinely reaches for `execute_action` where policy forbids
  it, which would be a product defect and the most important thing the live
  matrix found; or
- the golden set's `must_not_call` contract encodes an expectation the live
  prompt never establishes, which would make it a golden-set or prompt defect.

What is already known: the parity tests cover `execute_action` and pass, so
this is not a plumbing artifact, and `execute_action` refuses any draft_ref
other than the one the run just minted, so a call is not by itself an executed
side effect. Resolving this needs a human look at a failing trace, and it
should be resolved before anyone quotes the pass rates in this directory.

## Spend

Reconciled by `matrix:augment` with `MATRIX_SWEEP=1`; the assertion that
published plus superseded equals the ledger total passed.

| line | USD |
| --- | ---: |
| ledger total | 20.0286 |
| published (the three lanes above) | 12.6320 |
| superseded `claude-opus-5:cached` (both attempts) | 2.5225 |
| superseded `claude-haiku-4-5:uncached` (first attempt) | 1.9915 |
| superseded `unrecorded:swept` | 1.4754 |
| superseded `claude-haiku-4-5:cached` (first attempt) | 1.2048 |
| superseded `claude-sonnet-5:uncached` | 0.1920 |
| superseded manual reconciliation | 0.0104 |

Against a $65 hard envelope, so $44.97 of headroom was left unspent when the
workspace limit stopped the run. The `unrecorded:swept` line is money spent on
requests that completed and were billed but whose results the driver never
read, largely because of incidents 1 and 3. It is published as swept rather
than netted out.

The published figure is attributed by BATCH ID, not by lane name (incident 11),
so a lane that was run twice contributes only the attempt that survived into
this matrix.

Still absent, and therefore not measurements: both judge passes, the
interactive latency pass, every p50/p95 figure, and the judge-vs-human
calibration agreement. `latency.json` is empty by construction.

- L. Fox (Systems Architect)
