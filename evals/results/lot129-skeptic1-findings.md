# LOT-129 skeptic review: commit 5c13d4e (prompt 1.2.0 -> 1.3.0)

Reviewer: fresh-context skeptic, correctness scope only. Read-only + test runs.
Base: 4ff5228. Repo: novagait-backoffice.

## Verdict per claim

| # | Claim | Verdict |
|---|-------|---------|
| 1 | prompts.ts step 6 route-conditions execute_action, incl. negative example | CONFIRMED (text is as described; see regression risks) |
| 2 | PO-inference guard added to CITATIONS | CONFIRMED (with a scope caveat, F3) |
| 3 | tools.test.ts pins 1.3.0 + two load-bearing phrases | CONFIRMED but INCOMPLETE (F2) |
| 4 | 73 cassette diffs are stamp-only, zero route flips | CONFIRMED but WEAK EVIDENCE (F4) |
| 5 | 422/422, lint + typecheck clean | CONFIRMED (reproduced locally) |

Evidence:
- `git diff 4ff5228..5c13d4e -- evals/cassettes/` reduces to exactly two distinct
  changed lines x 73 files: `-"prompt_version": "1.2.0"` / `+"prompt_version": "1.3.0"`.
  Nothing else changed in any cassette.
- `npx vitest run` -> 47 files, 422 tests passed. `npm run lint` -> Prettier clean.
  `npm run typecheck` -> no output (pass).
- CASE-PLAN.md amendment 9 (line ~223 block, "LOT-106 amendments") states exactly
  the attempt-then-park contract the prompt now encodes: route cases no longer
  forbid execute_action; holds and rejects still do; golden.test.ts enforces the
  split (verified at golden.test.ts:87-110).
- Grader: deterministic.ts maps GR-EXEC -> GRD-004 and fires GRD-004 only via
  `must_not_call` containing `execute_action` (line 197). Golden sweep confirms
  every exception_hold/reject golden carries `must_not_call: ["execute_action"]`
  and every auto_approve/route_for_approval golden carries `[]`. Prompt and
  grader are consistent.

## Findings

### BLOCKING
None. No code path changed; the diff is prompt text plus a test pin.

### NON-BLOCKING

**F1 (highest value). The inverse failure is unmeasurable by the current harness.**
No golden lists `execute_action` in `expected.tool_calls` (checked all 73), and
`tool_calls` is graded as presence/ordered-subsequence. If the model regresses to
draft-only on auto_approve/route_for_approval:
- `tool_calls_present` passes (execute_action was never required),
- `must_not_call` passes (empty for those cases),
- `guardrail_fired` passes (GR-EXEC is the approval gate, not a `guardrail.check`
  block event; outcome.guardrails_fired only collects `guardrail.check` verdict
  "block" events — see outcome.ts:147-149 — and GR-FLOOR is a policy-time check
  that fires at draft time regardless of execution),
- `run_completed` passes, because live-agent.ts:779-785 settles a drafted-but-
  unexecuted run as `held`, and `held` is in COMPLETED_STATES.
judge.ts contains no execute_action/tool-etiquette criterion either.
Net: a 100% under-call regression on the 28 auto_approve + 15 route cases would
score clean while no invoice is ever paid. This blind spot predates the commit,
but the commit is precisely the change whose main risk it cannot see.
Recommendation: add `execute_action` to expected.tool_calls for approve/route
goldens (or a terminal-state expectation: executed / awaiting_approval), so the
harness can observe both directions.

**F2. The test pins only the prohibition, not the obligation.**
tools.test.ts asserts `"never call execute_action on a hold or a reject"` and
`"Never borrow a PO id"`. Both would fail if deleted (plain substring assertions
against buildSystemPrompt()) — the test is honest. But an edit that removes
"After drafting auto_approve or route_for_approval, call execute_action" while
leaving the prohibition intact passes the suite and produces exactly the F1
regression. Recommendation: add a third assertion pinning the positive clause.
Brittleness note (nit-level): exact-substring pinning breaks on any benign
rewording; acceptable as a deliberate canary, worth a comment saying so.

**F3. The PO guard is stated unconditionally and can leak into reject cases.**
New text: "if no PO number is printed on the document, the field is null and the
case is missing_po_reference." A reject document (not invoice-shaped, cases 015,
070-073) also prints no PO. The surrounding EXCEPTION VOCABULARY is scoped "When
you hold an invoice", but the new sentence carries no such scope and sits in
CITATIONS, far from that qualifier. Low-probability pull from reject -> hold
(GR-SCOPE would still fire on the reject path, but the drafted route could flip).
Recommendation: scope it, e.g. "on an invoice-shaped document, ...".

**F4. "Zero route flips in the mock lane" is near-vacuous as safety evidence.**
mock-agent.ts imports PROMPT_VERSION only (line 9, used at line 89 for the
stamp); it never calls buildSystemPrompt. The mock agent is prompt-blind by
construction, so a stamp-only cassette diff is the only possible outcome of any
prompt-text change. The claim is true and worth recording as a no-drift check on
the mock agent's own logic, but it is not evidence that the 1.3.0 wording is safe.

**F5. The behavioral fix is unverified.** evals/results/ contains only
matrix-2026-08-11 and spend-ledger-2026-08-11.json; no live-lane run exists at
1.3.0. GRD-004 remains adjudicated-but-unremeasured. Ship is fine (the code gate
GR-EXEC still contains every attempt), but do not state GRD-004 as fixed until a
live re-run exists.

### REGRESSION RISK ON PAYABLE ROUTES (wording analysis)

Is the new step 6 unambiguous for route_for_approval? Mostly yes: "After drafting
auto_approve or route_for_approval, call execute_action; ... if approval is
required and absent you will receive awaiting_approval, and the run pauses"
is explicit and names the parked outcome as expected. Residual risk, moderate-low:
- The vivid WRONG example ("the extra call is an attempted approval bypass and is
  graded as one") is the most salient token block in the section, and its framing
  ("hands the case to the human queue") also describes route_for_approval, which
  by definition needs a human. A model over-generalizing from the negative example
  could conclude that executing a case that needs approval is itself a bypass.
  Mitigation: pair it with an explicit RIGHT example, e.g. "RIGHT: route_for_approval
  -> execute_action -> awaiting_approval; the park IS the success case."
- OPERATING LIMITS ("If you are running short of room, draft the most defensible
  route ... and state plainly what you could not verify") gives a model under
  iteration pressure a licensed stopping point at draft_action. It speaks about
  routes, not execution, so it is not a direct contradiction, but combined with
  the new "the run is COMPLETE the moment draft_action returns" sentence (scoped
  to holds/rejects, but stated in absolute language) it slightly raises the odds
  of a premature stop on payable routes.

### NITS
- "payable routes" is new terminology; the rest of the prompt says "approve
  routes" (PAYMENT DRAFT FIELDS). Enumerated immediately after, so no ambiguity,
  but the drift is worth normalizing.
- The CITATIONS edit leaves a long unwrapped line ("... not evidence. Every
  policy claim in a draft"), breaking the file's ~72-col wrap. Cosmetic only;
  no semantic effect on the rendered prompt. Prettier does not flag it.
- No stale "Only after drafting" language survives; `execute_action` appears in
  the prompt only in step 6. No internal contradiction from the edit itself.
- reject's "Do not touch the ERP" is consistent with the new step 6.

## Overall
SHIP. No blocking correctness defect. Two follow-ups before GRD-004 can be
called closed: pin the positive execute_action clause in tools.test.ts (F2) and
give the goldens a way to observe under-calling (F1); then re-run the live lane
(F5).
