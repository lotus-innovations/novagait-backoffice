# GRD-004 before/after: prompt 1.2.0 -> 1.3.0 (LOT-129)

The deployed tier (claude-haiku-4-5) re-measured on PROMPT_VERSION 1.3.0
after the GRD-004 hardening. This is the Eval Baseline SKU story end to end:
the 2026-08-11 matrix measured the failure mode, the prompt was hardened,
and the same harness re-measured the fix.

## The finding (before)

On exception_hold cases the live model drafted the hold correctly and then
called execute_action anyway. GR-EXEC (the code-side approval gate)
contained 100% of attempts - no simulated money moved - but the attempt
itself violates the design contract (CASE-PLAN amendment 9: payable routes
may attempt and park; holds and rejects must never attempt). Root cause:
prompt step 6 said "Only after drafting, call execute_action" with no route
condition, and live models followed it literally. The mock agent never had
the defect, so the mock lane could not see it; only the paid matrix did.

## The fix (1.3.0, commits 5c13d4e + 7f168e5)

- Step 6 route-conditions execute_action: auto_approve/route_for_approval
  attempt and park; exception_hold/reject end at draft_action. WRONG and
  RIGHT examples included.
- EXT-003 guard: a PO reference must be quoted from the document; never
  borrowed from ERP lookups (the INV-004 hallucination class).
- Skeptic-review finding applied before re-measure: approve/route goldens
  now REQUIRE the execute_action attempt (CASE-PLAN amendment 13), so an
  under-calling regression is measurable, not invisible.

## Numbers (same rubric both sides)

Both columns graded under the amendment-13 goldens. The 1.2.0 side is the
paid 2026-08-11 checkpoints regraded at zero cost (matrix:regrade); the
regrade left the published 1.2.0 haiku pass counts unchanged, so the
published table remains valid as the "before".

| Lane | Metric | 1.2.0 | 1.3.0 |
|---|---|---|---|
| uncached | pass | 32/73 (43.8%) | 59/73 (80.8%) |
| uncached | P0 | .657 | .886 |
| uncached | GRD-004 attempts | 29 | 0 |
| cached | pass | 34/73 (46.6%) | 58/73 (79.5%) |
| cached | P0 | .714 | .829 |
| cached | GRD-004 attempts | 27 | 0 |

Gates at 1.3.0: guardrail_hard_zero PASSES both lanes (0 GRD-family
failures). p0_pass_rate still FAILS both lanes (.886 / .829 vs the .90
minimum) - see residuals.

## Residual failures, adjudicated

The uncached lane's 14 failures were checked case by case against their
checkpointed outcomes:

- 8x TOOL-001 where the model chose a wrong, conservative route (hold
  instead of approve/route) and then - correctly, per the new etiquette -
  never attempted execution. Root cause is decision quality, not tool
  etiquette; taxonomy precedence (TOOL > DEC) makes TOOL-001 the primary.
  1.2.0 had a comparable wrong-route count (7 DEC-001), so decision
  quality is unchanged; it is now the dominant remaining failure class.
- No under-calls on correctly-routed payable cases: every case the model
  routed approve/route also attempted execution. The inverse regression the
  skeptic flagged did not materialize.
- Remainder: 2x FMT, 1x SYS-003, 1x EXT-001, 1x EXT-003, 1x TOOL-004.

Next frontier for the P0 gate is routing accuracy on tolerance-edge and
receiving-timing cases, not guardrail behavior.

## Caveats

- Latency was not re-run (MATRIX_SKIP_LATENCY=1); the published 2026-08-11
  latency table still describes 1.2.0 and prompt changes of this size are
  not expected to move it materially. latency.json here is a placeholder.
- Judge verdicts are layer-3 (reported, never gated) and were re-run for
  table parity; calibration was NOT redone at 1.3.0 (the 2026-08-13
  human-score calibration measured the judge, not the prompt).
- The taxonomy's TOOL-over-DEC precedence now masks wrong-route as the
  primary code on payable-route failures (also visible in the replay
  baseline). Candidate cleanup for LOT-113: prefer DEC when the decision
  itself mismatches.
- Run interrupted overnight mid-cached-lane (driver killed by system sleep;
  no batch left in flight). Recovery: uncached lane resumed from its
  checkpoint at zero cost, cached lane re-ran, orphaned billed-but-unread
  spend swept into the ledger (MATRIX_SWEEP=1). Relaunch wrapped in
  caffeinate; RUN-LOG lesson for long paid runs on the Mini.
- Spend: LOT-129 all-in $3.91 (probe + smoke + lanes + judge + sweep);
  program ledger $48.36 against the $65 hard envelope.

Provenance: matrix.json (prompt 1.3.0, generated 2026-08-13),
regrade-under-current-goldens.json here and in matrix-2026-08-11/,
spend-ledger-2026-08-11.json, RUN-LOG in matrix-2026-08-11/.
