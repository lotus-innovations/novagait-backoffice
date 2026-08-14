# LOT-105 live model matrix

Generated 2026-08-11. Prompt 1.2.0, tools 1.0.0, SDK 0.115.0. Pricing verified 2026-08-11.

Deployed tier: `claude-haiku-4-5`. Only that tier's gates block release (spec 09 §4); the other rows are published for comparison.

## Published matrix

| model | mode | pass rate | P0 pass rate | mean $/run | $/correct run | p50 ms | p95 ms | model vs policy |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `claude-haiku-4-5` | uncached | 43.8% | 65.7% | $0.0247 | $0.0564 | 17946 | 32962 | 0 |
| `claude-haiku-4-5` | cached | 46.6% | 71.4% | $0.0139 | $0.0299 | 17946 | 32962 | 4 |
| `claude-sonnet-5` | uncached | 39.7% | 57.1% | $0.0598 | $0.1505 | 21772 | 32300 | 1 |
| `claude-sonnet-5` | cached | 38.4% | 60.0% | $0.0307 | $0.0802 | 21772 | 32300 | 2 |
| `claude-opus-5` | uncached | 37.0% | 62.9% | $0.1344 | $0.3634 | 41012 | 67867 | 4 |
| `claude-opus-5` | cached | 35.6% | 62.9% | $0.0765 | $0.2148 | 41012 | 67867 | 4 |

- **OUTPUT CAP, `claude-haiku-4-5` cached: 1 of 73 runs ended on the output-token cap.** A capped run is cut off mid-turn, and one cut off inside its `draft_action` reaches no disposition at all, so it grades as a failure for running out of room rather than for judgement. This row measures the model UNDER THAT CAP and is not a clean capability comparison against a row that did not truncate.
- **OUTPUT CAP, `claude-sonnet-5` uncached: 3 of 73 runs ended on the output-token cap.** A capped run is cut off mid-turn, and one cut off inside its `draft_action` reaches no disposition at all, so it grades as a failure for running out of room rather than for judgement. This row measures the model UNDER THAT CAP and is not a clean capability comparison against a row that did not truncate.
- **OUTPUT CAP, `claude-sonnet-5` cached: 6 of 73 runs ended on the output-token cap.** A capped run is cut off mid-turn, and one cut off inside its `draft_action` reaches no disposition at all, so it grades as a failure for running out of room rather than for judgement. This row measures the model UNDER THAT CAP and is not a clean capability comparison against a row that did not truncate.
- **OUTPUT CAP, `claude-opus-5` uncached: 30 of 73 runs ended on the output-token cap.** A capped run is cut off mid-turn, and one cut off inside its `draft_action` reaches no disposition at all, so it grades as a failure for running out of room rather than for judgement. This row measures the model UNDER THAT CAP and is not a clean capability comparison against a row that did not truncate.
- **OUTPUT CAP, `claude-opus-5` cached: 25 of 73 runs ended on the output-token cap.** A capped run is cut off mid-turn, and one cut off inside its `draft_action` reaches no disposition at all, so it grades as a failure for running out of room rather than for judgement. This row measures the model UNDER THAT CAP and is not a clean capability comparison against a row that did not truncate.

Latency is measured on the interactive lane, uncached, and is therefore
identical across a model's two cache rows (spec 13 §3).

"model vs policy" counts cases where the model proposed one route and
policy disposed another. It is reported, never graded: the disposed
route is the product's answer, and this column says how often the
guardrails did the deciding.

## Gates

- `claude-haiku-4-5:uncached` FAIL (blocking)
    - p0_pass_rate: FAIL (P0 pass rate 0.657 vs minimum 0.9)
    - guardrail_hard_zero: FAIL (29 GRD-family failures, maximum 0)
    - p0_no_regression: pass (no baseline to compare against)
    - aggregate_no_drop: pass (no baseline to compare against)
- `claude-haiku-4-5:cached` FAIL (blocking)
    - p0_pass_rate: FAIL (P0 pass rate 0.714 vs minimum 0.9)
    - guardrail_hard_zero: FAIL (27 GRD-family failures, maximum 0)
    - p0_no_regression: pass (no baseline to compare against)
    - aggregate_no_drop: pass (no baseline to compare against)
- `claude-sonnet-5:uncached` FAIL (informational)
    - p0_pass_rate: FAIL (P0 pass rate 0.571 vs minimum 0.9)
    - guardrail_hard_zero: FAIL (35 GRD-family failures, maximum 0)
    - p0_no_regression: pass (no baseline to compare against)
    - aggregate_no_drop: pass (no baseline to compare against)
- `claude-sonnet-5:cached` FAIL (informational)
    - p0_pass_rate: FAIL (P0 pass rate 0.600 vs minimum 0.9)
    - guardrail_hard_zero: FAIL (33 GRD-family failures, maximum 0)
    - p0_no_regression: pass (no baseline to compare against)
    - aggregate_no_drop: pass (no baseline to compare against)
- `claude-opus-5:uncached` FAIL (informational)
    - p0_pass_rate: FAIL (P0 pass rate 0.629 vs minimum 0.9)
    - guardrail_hard_zero: FAIL (22 GRD-family failures, maximum 0)
    - p0_no_regression: pass (no baseline to compare against)
    - aggregate_no_drop: pass (no baseline to compare against)
- `claude-opus-5:cached` FAIL (informational)
    - p0_pass_rate: FAIL (P0 pass rate 0.629 vs minimum 0.9)
    - guardrail_hard_zero: FAIL (25 GRD-family failures, maximum 0)
    - p0_no_regression: pass (no baseline to compare against)
    - aggregate_no_drop: pass (no baseline to compare against)

## Metric caveats

Carried from `evals/thresholds.json`. These are measurement
limits, not results: read them before quoting any number above.

- **vendor_id_field_accuracy**: Degenerate on BOTH lanes and NOT a model measurement. The vendor id is re-resolved in code from the printed name (resolveVendorName) in the mock lane and in the live lane alike, and the model's claimed vendor_id is overwritten before the extraction is stashed. This field is therefore 100% by construction and must not be reported as extraction accuracy.
- **output_schema_valid**: Reduced to drafted/not-drafted on both lanes. Neither lane traces the full extraction on draft_action (arg redaction would rewrite remit_to and make it unparseable), so the graded projection reads the extraction from run state, where it was written by code that already validated it. FMT therefore distinguishes a run that drafted from a run that did not, and nothing finer.
- **decision**: The graded decision is the DISPOSED route, not the model's proposal: code floor-checks the model's route against the deterministic route and can escalate it. A model that under-routes a case policy holds still scores as correct on DEC. The raw proposal is in the trace as draft_action.args.model_route; the matrix's divergence column is what measures model-vs-policy.

## Spend

Actual: $44.45 against a $65 envelope.

- MODEL-VS-POLICY DIVERGENCE was BROKEN in the 2026-08-11 publication and read 0 on every lane. The join took the model's proposed route from a process-local map that only holds cases run in THAT invocation, and every published lane was resumed from a checkpoint, so it joined against nothing and rendered the empty result as zero. The proposal is now persisted on the record; the already-published lanes were recovered from stored batch results (matrix:backfill-routes) at zero spend. Only proposals the driver actually TRACED count: a draft_action truncated by the max_tokens cap, or rejected by the tool schema, is never executed, and counting those fabricated 22 divergences on the opus lane and 1 on haiku:uncached before it was tightened.
- claude-haiku-4-5:uncached: 66 of 73 cases carry a traced model proposal, so the divergence figure is a measurement over 66 cases, not over the lane. Of the rest, 5 short-circuited before any model turn (GR-SCOPE), 2 reached no disposition at all, and 0 ended on the 2048-token output cap. Those groups overlap; they are counted, not apportioned.
- claude-haiku-4-5:cached: 66 of 73 cases carry a traced model proposal, so the divergence figure is a measurement over 66 cases, not over the lane. Of the rest, 5 short-circuited before any model turn (GR-SCOPE), 2 reached no disposition at all, and 1 ended on the 2048-token output cap. Those groups overlap; they are counted, not apportioned.
- claude-sonnet-5:uncached: 66 of 73 cases carry a traced model proposal, so the divergence figure is a measurement over 66 cases, not over the lane. Of the rest, 5 short-circuited before any model turn (GR-SCOPE), 2 reached no disposition at all, and 3 ended on the 2048-token output cap. Those groups overlap; they are counted, not apportioned.
- claude-sonnet-5:cached: 63 of 73 cases carry a traced model proposal, so the divergence figure is a measurement over 63 cases, not over the lane. Of the rest, 5 short-circuited before any model turn (GR-SCOPE), 5 reached no disposition at all, and 6 ended on the 2048-token output cap. Those groups overlap; they are counted, not apportioned.
- claude-opus-5:uncached: 41 of 73 cases carry a traced model proposal, so the divergence figure is a measurement over 41 cases, not over the lane. Of the rest, 5 short-circuited before any model turn (GR-SCOPE), 27 reached no disposition at all, and 30 ended on the 2048-token output cap. Those groups overlap; they are counted, not apportioned.
- claude-opus-5:cached: 45 of 73 cases carry a traced model proposal, so the divergence figure is a measurement over 45 cases, not over the lane. Of the rest, 5 short-circuited before any model turn (GR-SCOPE), 23 reached no disposition at all, and 25 ended on the 2048-token output cap. Those groups overlap; they are counted, not apportioned.
- Calibration agreement is NOT in this directory. The 12 draft(s) in calibration-worksheet.md are scored by a human (Abhinav); the agreement and disagreement tables are computed in a follow-up pass from those scores.
- Latency overrides: per-run breaker lifted to $1.00 and wall clock to 600s, so an opus run is measured rather than cost-capped. Production containment is unchanged and is NOT what this lane measures.
- Short-circuit savings: 5 of 73 golden cases are rejected by the pre-model GR-SCOPE screen and never cost a request, so every round batches 68, not 73.
- Batch progress is NOT observable from request_counts: a batch reports zero completions for its whole life and then jumps to final counts, so any completion-based stall heuristic cancels healthy work. Stall handling is elapsed-time only. Measured 2026-08-12: haiku and opus batches of 16 requests ended in 2-3 minutes, while two sonnet-5 batches of the same shape took 2.5 and 6 HOURS and ended with all 16 requests succeeded - per-model batch cadence differs by two orders of magnitude and cannot be assumed from another model's behaviour. It is not stable over TIME either: a control probe on 2026-08-12 at 21:41Z ended a sonnet-5 batch in 3.1 minutes, so the multi-hour figures were a transient queue condition and not a property of the model. Any schedule built on either number is a guess; the ledger, not a stopwatch, is the health signal.
- NO MOCK BASELINE WAS LOADED (evals/baseline/latest.json absent), so the regression gates (p0_no_regression, aggregate_no_drop) had nothing to compare against and PASSED VACUOUSLY. Do not read those two gates as evidence of no regression; only the gates that evaluated real data (p0_pass_rate, guardrail_hard_zero) carry a verdict.
- Run history, incidents and the per-lane attempt history (which attempt each lane was published from, and what happened to the others) are in RUN-LOG.md in this directory. Read it before quoting any number here.
- Reviewer N3: a live model that resolves MORE vendors than the mock planner emits extra lookup_vendor and memory.read events. That is correct behaviour, not a defect: grading fails only on MISSING required calls or must_not_call violations, so a higher tool count is not a penalty and should not be read as noise.

## Judge calibration

Human-vs-judge agreement on 12 blinded drafts: verdict agreement 7/12,
mean absolute score difference 0.231, and every disagreement in the
conservative direction (the judge never scored a draft above the human).
Full table, method and caveats: calibration-results.md.

<!-- generated by matrix:augment -->
## Cache behaviour, round by round

The cached column is only a saving while the 1h TTL survives the gap
between batch rounds. Where it does, reads dominate and the lane is
cheaper; where a round cadence exceeds the TTL, every round pays a 2x
write instead of a 0.1x read and caching inverts. Both outcomes are
reported here as measured.

| lane | round | requests | cache read tok | cache write tok | reads dominate |
| --- | ---: | ---: | ---: | ---: | :--- |
| `claude-haiku-4-5:cached` | 0 | 68 | 222176 | 62880 | n/a (first round always writes) |
| `claude-haiku-4-5:cached` | 1 | 67 | 280864 | 0 | yes |
| `claude-haiku-4-5:cached` | 2 | 66 | 276672 | 0 | yes |
| `claude-haiku-4-5:cached` | 3 | 65 | 272480 | 0 | yes |
| `claude-haiku-4-5:cached` | 4 | 60 | 251520 | 0 | yes |
| `claude-haiku-4-5:cached` | 5 | 35 | 146720 | 0 | yes |
| `claude-haiku-4-5:cached` | 6 | 20 | 83840 | 0 | yes |
| `claude-haiku-4-5:cached` | 7 | 6 | 25152 | 0 | yes |
| `claude-haiku-4-5:cached` | 8 | 5 | 20960 | 0 | yes |
| `claude-haiku-4-5:cached` | 9 | 2 | 8384 | 0 | yes |
| `claude-sonnet-5:cached` | 0 | 68 | 340430 | 51930 | n/a (first round always writes) |
| `claude-sonnet-5:cached` | 1 | 68 | 392360 | 0 | yes |
| `claude-sonnet-5:cached` | 2 | 68 | 392360 | 0 | yes |
| `claude-sonnet-5:cached` | 3 | 64 | 369280 | 0 | yes |
| `claude-sonnet-5:cached` | 4 | 63 | 363510 | 0 | yes |
| `claude-sonnet-5:cached` | 5 | 42 | 242340 | 0 | yes |
| `claude-sonnet-5:cached` | 6 | 12 | 69240 | 0 | yes |
| `claude-sonnet-5:cached` | 7 | 4 | 23080 | 0 | yes |
| `claude-sonnet-5:cached` | 8 | 3 | 17310 | 0 | yes |
| `claude-sonnet-5:cached` | 9 | 2 | 11540 | 0 | yes |
| `claude-opus-5:cached` | 0 | 68 | 325014 | 62722 | n/a (first round always writes) |
| `claude-opus-5:cached` | 1 | 68 | 387736 | 0 | yes |
| `claude-opus-5:cached` | 2 | 68 | 387736 | 0 | yes |
| `claude-opus-5:cached` | 3 | 57 | 325014 | 0 | yes |
| `claude-opus-5:cached` | 4 | 48 | 273696 | 0 | yes |
| `claude-opus-5:cached` | 5 | 34 | 193868 | 0 | yes |
| `claude-opus-5:cached` | 6 | 18 | 102636 | 0 | yes |
| `claude-opus-5:cached` | 7 | 4 | 22808 | 0 | yes |

- `claude-haiku-4-5:cached`: caching held. 1588768 read tokens against 62880 written.
- `claude-sonnet-5:cached`: caching held. 2221450 read tokens against 51930 written.
- `claude-opus-5:cached`: caching held. 2018508 read tokens against 62722 written.

## Spend reconciliation

Ledger total: $44.4528.
Attributable to this matrix: $36.6916.

Real spend that bought nothing published, itemised rather than folded
into the total:

- `claude-haiku-4-5:uncached`: $1.9915 — spent by a run attempt that was cancelled or restarted; the batches completed and were billed, but their results are not in this matrix
- `claude-haiku-4-5:cached`: $1.2048 — spent by a run attempt that was cancelled or restarted; the batches completed and were billed, but their results are not in this matrix
- `claude-sonnet-5:uncached`: $0.1920 — spent by a run attempt that was cancelled or restarted; the batches completed and were billed, but their results are not in this matrix
- `claude-opus-5:cached`: $2.8023 — spent by a run attempt that was cancelled or restarted; the batches completed and were billed, but their results are not in this matrix
- `unrecorded:swept`: $1.5603 — spent by a run attempt that was cancelled or restarted; the batches completed and were billed, but their results are not in this matrix
- `manual reconciliation`: $0.0104 — a batch that completed and was billed before a retrieval bug threw; usage re-fetched from the API and recorded so the envelope is honest

Published plus superseded equals the ledger total.
