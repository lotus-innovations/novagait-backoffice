# LOT-105 matrix driver: the LOT-120 seam

**Status: integrated 2026-08-11 against LOT-120 (c029996).** Every assumption
below held. Three things landed under different names or ownership than
assumed; those are marked RESOLVED with what actually shipped. Kept as the
record of what the driver depends on, so a future change to the live surface
can be checked against it.

The matrix driver is written and tested against the seam declared in
`types.ts`. Nothing here is a request for new design: every assumption is
drawn from how the mock lane already behaves (`packages/pipeline/src/mock-agent.ts`,
`evals/runner/src/cassettes/record.ts`), so satisfying it should be a
by-product of building `runLivePipeline`, not extra work.

If any of these is wrong, say so and I will move the driver, not the product.

## A1. A per-case session owns a store, a run id, and executors

**RESOLVED, and then absorbed by the product.** `openLiveRun` shipped first;
`c029996` then added `createLivePipeline<TOutcome>({seedFixtures?, toOutcome,
resolveCase?, preSeed?})`, which owns the store per case, ERP seeding, the
enqueue, pre-seeding, `run.start`, the disposition and `run.end`.

`live-pipeline.ts` is now thin: it injects `toOutcome` (the projection) and
`resolveCase`, wraps the product session to satisfy `LiveSession`, and keeps
the tool-call tracing wrapper. The driver is unchanged by any of it.

The driver needs, for one golden case:

- a `Store` seeded exactly as the recorder seeds it (backend seeded, the
  case's fixture enqueued on the inbox index),
- a `runId` that the trace is written under,
- a `ToolExecutors` (all 8 tools) bound to that store and run,
- the intake `userMessage` the live lane would send as the first user turn.

Shape: `LivePipeline.openCase(goldenCase, opts) -> LiveSession` (`types.ts`).

**Why a session rather than bare executors:** guardrails, the state machine
and the approval gate are stateful per run. The mock lane holds that state in
the store keyed by run id (`RunStateMachine.load(store, runId)`); the live
executors need the same handle, and the driver must not be the thing that
knows how to construct it.

## A2. Executors are pure of transport and safe to call between batch rounds

The Batch API does not run tool loops, so the driver batches **one model turn
at a time**: submit a round for every in-flight case, retrieve, execute that
round's tool calls locally, submit the next round. Executors are therefore
called outside any agent loop, possibly minutes after the model turn that
requested them, and always in the driver's process.

Assumption: an executor is an ordinary async function of its parsed input
that reads and writes only the session's store and backend. No hidden
dependence on being invoked inside `runWorkflow`, no wall-clock coupling to
the model turn, no module-level mutable state shared across sessions (73
sessions per lane are open concurrently).

## A3. `RunOutcome` is derived the way the recorder derives it

After the loop ends the driver calls `session.toOutcome()` and expects the
same projection `record.ts` performs today:

- trace events via `readTrace(store, runId)` into `fromTraceEvents`,
- extraction from the run state machine when the trace carries only
  `{route, summary}` on `draft_action`,
- `decision` falling back to the pipeline's route when a `GR-SCOPE` reject
  short-circuits before any `draft_action`,
- `output_schema_valid` satisfied (not failed) on that same reject path.

**This is load-bearing for the gates.** `guardrails_fired` must come from
`guardrail.check` events with `verdict: "block"`, and `terminal_state` from
`run.end`, both written by product code. If the live path emits these
differently from the mock path, the GRD hard-zero and P0 gates change meaning
and the published matrix stops being comparable to the replay baseline.

## A4. Disposition is identical to the mock lane

Same `guardrails.ts` checks, same `constrainRoute`, same approval gate, same
autonomy and hard-floor constants from `policy-constants.ts`. The live lane
should differ from the mock lane in exactly one respect: a model chooses the
tool calls instead of a deterministic planner. Anything else is a behavioural
difference the eval cannot attribute to the model.

## A5. Pre-seeded predecessor runs are still needed

**RESOLVED, twice.** Briefly the eval's job, now the product's:
`createLivePipeline` defaults `preSeed` to `LIVE_PRE_SEED_RUNS` and runs
predecessors through the deterministic pipeline itself. The eval supplies only
`resolveCase: (id) => byId.get(id)` so the factory can find INV-001 when
opening INV-010.

`record.ts` `PRE_SEED_RUNS` runs `INV-001` before `INV-010` so the duplicate
guardrail has ledger history to find. The live lane needs the same
pre-seeding, and the predecessor may run through the deterministic pipeline
(it is set-up, not measurement). Assumption: `openCase` handles pre-seeding
internally, or exposes a hook for it. The driver does not want to know.

## A6. Iteration and cost caps stay the driver's job

`runWorkflow` enforces `MAX_ITERATIONS`, the per-run breaker and the wall
clock. The driver does not call `runWorkflow` (it cannot: batching splits the
loop), so it re-implements the iteration cap at 10 rounds and records
`iteration_capped` itself. Assumption: nothing inside the executors depends on
the loop having enforced those caps, and it is acceptable that the per-run
cost breaker does not apply to batch rounds (the lane-level ledger and the
$65 hard stop are the containment here, per spec 13 §3).

## A7. Thinking and cache configuration are unchanged

The driver builds requests with `buildCachedSystem` and `resolveThinking`
from `@novagait/agent` so the cached bytes and the thinking allowlist are the
product's, not the eval's. Assumption: those two functions keep their current
signatures, and `THINKING_CONFIG_SUPPORTED` remains the single place model
capability is decided.

## A8. NEW, from LOT-120: the pre-model short circuit

The product session exposes `shortCircuited: true` (from `openLiveRun`'s
`shortCircuit`) when the GR-SCOPE screen rejects the document. The run is already complete and fully traced, and **the
model must not be called**. The driver treats such a case as born done: it
never enters a round and never costs a request. This is mandatory rather than
an optimisation: the executors refuse work after `run.end`, so a lane that
ignored the flag would pay for a request the run cannot use. `toOutcome()` still projects a real graded result, with the
route taken from the disposition (the reject path writes no `draft_action`
the projection could read a decision from).

Covered by `live-pipeline.test.ts`, which drives INV-015 end to end through
the real surface into the graders with no model and no spend.

## A9. NEW, from LOT-120: tool-call tracing is the driver's job

`runWorkflow`'s `tracedExecutors` wrapper is what normally writes `tool.call`,
and the batch driver cannot use `runWorkflow`. `live-pipeline.ts` therefore
mirrors that wrapper exactly, including the `traceArgs` projection, which maps
`draft_action` to the mock-lane shape `{route, summary, model_route}` and
deliberately keeps the extraction out of the trace (arg redaction would
rewrite `remit_to` and make it unparseable downstream; the graders read the
extraction from run state instead).

If these two wrappers ever diverge, a batched run and an interactive run leave
different traces and the graders silently see different runs. That is the
single most fragile seam in this integration.

**They did diverge, and it was live.** The mirror computed `traceArgs` BEFORE
awaiting the executor; `loop.ts` computes it after, by evaluating the
projector inside the append expression. On `draft_action` the projector reads
`drafted`, which the executor itself sets (live-agent.ts:614), so the mirror
always saw null and fell back to the model's raw proposal. Every graded
`decision` would have been what the model wanted rather than what policy
allowed: GRD hard-zero firing on correctly-disposed runs, and a divergence
column reading zero for all 73 cases. Plausible-looking numbers, wrong on
precisely the cases guardrails exist for, and invisible to both test suites
because the fake pipeline never made the projector depend on executor state.

Found by the reviewer, fixed 2026-08-11. `trace-ordering.test.ts` now pins the
contract: it was confirmed to fail with the old ordering (`expected
'auto_approve' to be 'exception_hold'`) and to pass with the new one, so it is
a proven guard rather than an assumed one. The test asserts the observable
contract, not the implementation, so it stays valid when this wrapper is
replaced by the product's exported `traceToolCalls`.

## Not assumed

- No assumption about how executors are constructed internally.
- No assumption that `runWorkflow` gains a batch mode.
- No assumption about the pricing fix beyond it landing in `packages/agent`;
  the ledger does its own cost math regardless (`ledger.ts`), because the
  batch discount and the 1h cache-write multiplier are matrix-lane concerns
  that the per-run runtime function has no reason to model.

Author L. Fox, 2026-08-11 (LOT-105, pre-build against LOT-120).
