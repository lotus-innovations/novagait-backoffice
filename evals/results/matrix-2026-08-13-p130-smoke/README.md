# LOT-105 live model matrix

Generated 2026-08-13. Prompt 1.3.0, tools 1.0.0, SDK 0.115.0. Pricing verified 2026-08-11.

Deployed tier: `claude-haiku-4-5`. Only that tier's gates block release (spec 09 §4); the other rows are published for comparison.

## Published matrix

| model | mode | pass rate | P0 pass rate | mean $/run | $/correct run | p50 ms | p95 ms | model vs policy |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `claude-haiku-4-5` | uncached | 100.0% | 100.0% | $0.0232 | $0.0232 | n/a | n/a | 0 |

Latency is measured on the interactive lane, uncached, and is therefore
identical across a model's two cache rows (spec 13 §3).

"model vs policy" counts cases where the model proposed one route and
policy disposed another. It is reported, never graded: the disposed
route is the product's answer, and this column says how often the
guardrails did the deciding.

## Gates

- `claude-haiku-4-5:uncached` PASS (blocking)
    - p0_pass_rate: pass (P0 pass rate 1.000 vs minimum 0.9)
    - guardrail_hard_zero: pass (0 GRD-family failures, maximum 0)
    - p0_no_regression: pass (no baseline to compare against)
    - aggregate_no_drop: pass (no baseline to compare against)

## Metric caveats

Carried from `evals/thresholds.json`. These are measurement
limits, not results: read them before quoting any number above.

- **vendor_id_field_accuracy**: Degenerate on BOTH lanes and NOT a model measurement. The vendor id is re-resolved in code from the printed name (resolveVendorName) in the mock lane and in the live lane alike, and the model's claimed vendor_id is overwritten before the extraction is stashed. This field is therefore 100% by construction and must not be reported as extraction accuracy.
- **output_schema_valid**: Reduced to drafted/not-drafted on both lanes. Neither lane traces the full extraction on draft_action (arg redaction would rewrite remit_to and make it unparseable), so the graded projection reads the extraction from run state, where it was written by code that already validated it. FMT therefore distinguishes a run that drafted from a run that did not, and nothing finer.
- **decision**: The graded decision is the DISPOSED route, not the model's proposal: code floor-checks the model's route against the deterministic route and can escalate it. A model that under-routes a case policy holds still scores as correct on DEC. The raw proposal is in the trace as draft_action.args.model_route; the matrix's divergence column is what measures model-vs-policy.

## Spend

Actual: $44.52 against a $65 envelope.

- MODEL-VS-POLICY DIVERGENCE was BROKEN in the 2026-08-11 publication and read 0 on every lane. The join took the model's proposed route from a process-local map that only holds cases run in THAT invocation, and every published lane was resumed from a checkpoint, so it joined against nothing and rendered the empty result as zero. The proposal is now persisted on the record; the already-published lanes were recovered from stored batch results (matrix:backfill-routes) at zero spend. Only proposals the driver actually TRACED count: a draft_action truncated by the max_tokens cap, or rejected by the tool schema, is never executed, and counting those fabricated 22 divergences on the opus lane and 1 on haiku:uncached before it was tightened.
- claude-haiku-4-5:uncached: 3 of 3 cases carry a traced model proposal, so the divergence figure is a measurement over 3 cases, not over the lane. Of the rest, 0 short-circuited before any model turn (GR-SCOPE), 0 reached no disposition at all, and 0 ended on the 2048-token output cap. Those groups overlap; they are counted, not apportioned.
- Calibration agreement is NOT in this directory. The 0 draft(s) in calibration-worksheet.md are scored by a human (Abhinav); the agreement and disagreement tables are computed in a follow-up pass from those scores.
- INCOMPLETE MATRIX: 1 of 6 lanes are present. Missing: `claude-haiku-4-5:cached`, `claude-sonnet-5:uncached`, `claude-sonnet-5:cached`, `claude-opus-5:uncached`, `claude-opus-5:cached`. This is not a release verdict, and no cross-tier comparison here is complete. RUN-LOG.md says why each lane is absent.
- LATENCY PASS DID NOT RUN in this invocation, so p50/p95 are absent and latency.json is empty. No latency claim in this directory is a measurement.
- SMOKE RUN. A deliberately tiny subset used to prove the pipeline end to end before the published run. Not the matrix; do not cite these numbers.
- Short-circuit savings: 0 of 3 golden cases are rejected by the pre-model GR-SCOPE screen and never cost a request, so every round batches 3, not 3.
- Batch progress is NOT observable from request_counts: a batch reports zero completions for its whole life and then jumps to final counts, so any completion-based stall heuristic cancels healthy work. Stall handling is elapsed-time only. Measured 2026-08-12: haiku and opus batches of 16 requests ended in 2-3 minutes, while two sonnet-5 batches of the same shape took 2.5 and 6 HOURS and ended with all 16 requests succeeded - per-model batch cadence differs by two orders of magnitude and cannot be assumed from another model's behaviour. It is not stable over TIME either: a control probe on 2026-08-12 at 21:41Z ended a sonnet-5 batch in 3.1 minutes, so the multi-hour figures were a transient queue condition and not a property of the model. Any schedule built on either number is a guess; the ledger, not a stopwatch, is the health signal.
- NO MOCK BASELINE WAS LOADED (evals/baseline/latest.json absent), so the regression gates (p0_no_regression, aggregate_no_drop) had nothing to compare against and PASSED VACUOUSLY. Do not read those two gates as evidence of no regression; only the gates that evaluated real data (p0_pass_rate, guardrail_hard_zero) carry a verdict.
- Run history, incidents and the per-lane attempt history (which attempt each lane was published from, and what happened to the others) are in RUN-LOG.md in this directory. Read it before quoting any number here.
- Reviewer N3: a live model that resolves MORE vendors than the mock planner emits extra lookup_vendor and memory.read events. That is correct behaviour, not a defect: grading fails only on MISSING required calls or must_not_call violations, so a higher tool count is not a penalty and should not be read as noise.
