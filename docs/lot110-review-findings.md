# LOT-110 architecture docs — skeptical review findings

Scope: factual accuracy of `docs/architecture.md` and
`docs/engagement/03-architecture.md` (commit 4e82823) against the source they
describe. Read-only review; this file is the only write. Verified by opening
source, not by inference.

Overall verdict: **FIX-FIRST** — two claims are wrong in a way a prospect
could catch (one number, one metric label). Everything else is accurate;
the remaining items are omissions and wording.

---

## 1. Component view — CONFIRMED (with omissions)

Verified:

- `package.json` workspaces = `apps/web`, `packages/*`, `evals/runner`.
  Matches the "Workspaces:" sentence, and `packages/*` is exactly agent,
  pipeline, mock-backend.
- Every agent module named in the diagram exists in `packages/agent/src/`:
  loop, prompts, tools, guardrails, approval, run-state, trace, trace-writer,
  memory, kb, retrieval, store (+ `store-redis.ts` holding `RedisStore` and
  `createStore`).
- `packages/pipeline/src/index.ts` exports exactly execute, match,
  mock-agent, parse, reset, resume, live-agent — the six boxes drawn.
  `runLivePipeline` (live-agent.ts:1051) and `runMockPipeline`
  (mock-agent.ts:64) exist under those names.
- `packages/mock-backend` has `fixtures/` and the `gen:fixtures` script
  (`packages/mock-backend/package.json`).
- App routes `/ · /runs · /approvals · /memory · /backend · /eval · /admin`
  all exist under `apps/web/src/app/`.

Findings:

- **NON-BLOCKING — two route handlers omitted.** The diagram lists
  `/api/intake · /api/dev/run · /api/maintenance/reset · /api/admin/*`.
  Also present: `apps/web/src/app/api/approvals/[id]/route.ts` (the human
  decision endpoint — the load-bearing half of the approval story) and
  `apps/web/src/app/api/runs/[id]/trace.jsonl/route.ts` (the JSONL export
  the doc advertises in §5/§7 and the client doc advertises in §6). Both
  deserve to be in the list.
- **NIT — `/admin` is a route handler, not a page.**
  `apps/web/src/app/admin/route.ts` is a handler; the diagram files it under
  "Routes:" with the UI pages.
- **NIT — agent modules not drawn:** containment, extraction, pricing,
  similarity, redact, policy-constants. Containment in particular appears in
  the §3 sequence as work done by `apps/web`, but the code lives in
  `packages/agent/src/containment.ts` (`checkIpLimit`, `checkSessionCap`,
  `isCapacityMode`, called from `apps/web/src/app/api/intake/route.ts`).
  The sequence is not wrong about where it runs; the component view just
  never names the module.

## 2. State machine — CONFIRMED

`packages/agent/src/run-state.ts` `TRANSITIONS`:

```
ingested -> extracted, rejected
extracted -> matched, held, rejected
matched -> decided
decided -> awaiting_approval, executed, held, rejected
awaiting_approval -> executed, held, rejected, decided
executed/held/rejected/cost_capped/iteration_capped/error -> []
```

The §4 `stateDiagram-v2` reproduces all 14 edges and adds none. Both
directions check out: no doc edge is missing from TRANSITIONS, no TRANSITIONS
edge is missing from the doc.

Also confirmed: `TERMINAL_STEPS` = the six the doc lists; `ABORT_STEPS` =
cost_capped, iteration_capped, error (doc's "enterable from any non-terminal
step" matches the code comment and the guard); `MAX_REVISIONS = 1`;
`RUN_STATE_TTL_SECONDS = 24 * 60 * 60` (the "24h TTL" claim).

Client §3 simplification: every edge drawn is a real edge
(`ingested -> rejected`, `awaiting_approval -> decided`,
`awaiting_approval -> held`, etc.). It omits `extracted -> held/rejected`
and the abort states, and covers the aborts in prose ("runs also stop on
their own if they exceed a per-run cost or iteration budget"). Simplified,
not wrong.

## 3. Sequence diagram / gate — CONFIRMED

- Tool names: `lookup_vendor`, `lookup_po`, `lookup_receiving`,
  `check_duplicate`, `draft_action`, `execute_action` all present in
  `tools.ts` (the tool set also includes `kb_search` and
  `update_vendor_profile`, which the sequence does not draw — **nit**).
- Guardrail ids: `guardrails.ts` defines exactly
  `GR-INJECT | GR-SCOPE | GR-FLOOR | GR-VENDOR | GR-DUP`; GR-EXEC lives in
  `approval.ts` as the doc says.
- Trace event names used in the diagram (`run.start`, `model.request`,
  `model.response`, `guardrail.check`, `approval.requested`,
  `approval.decided`, `backend.write`, `run.end`) are all real event types.
- **"GR-EXEC decides from the disposed route" — ACCURATE.**
  `gateExecuteAction` (approval.ts:193) calls `canAutoApprove(context.
autonomy)`, which rejects anything whose `route !== "auto_approve"` and
  then applies `AUTONOMY_CAP_CENTS` / `HARD_FLOOR_CENTS` from
  `policy-constants.ts`. The model's own assertion is never consulted.
  **NIT:** the gate also short-circuits on `mode === "shadow"` (executes
  with `simulated: true`) and on an existing approval record
  (approved/edit_approved/rejected/pending) before the autonomy check. The
  diagram's single "GR-EXEC gate" box hides the shadow path, which matters
  because shadow mode is one of the three supported modes.

## 4. Trace schema §7 — CONFIRMED

- **Event types:** trace.ts's `TraceEvent` union and `REQUIRED_BY_TYPE` both
  contain exactly the 12 types the doc lists — run.start, model.request,
  model.response, tool.call, guardrail.check, memory.read, memory.write,
  approval.requested, approval.decided, backend.write, error, run.end.
  None missing, none invented.
- `TRACE_SCHEMA_VERSION = 2` (trace.ts:18).
- The v1 -> v2 migration note matches the file header comment
  (trace.ts:1-14) point for point: `error` added with `scope` / `message` /
  `recoverable`; `EventBase.mode` formalized, introduced additive-optional
  during v1 (trace.ts:37-41 says so, citing LOT-102).
- **Compatibility claim is correct given `validateTraceEvent`
  (trace.ts:195-217).** The validator checks only (a) the type is a key of
  `REQUIRED_BY_TYPE`, (b) presence of `BASE_FIELDS`, (c) presence of the
  per-type required fields. It never rejects unknown keys, so forward
  compatibility holds literally. `mode` is not in `BASE_FIELDS`, so adding
  it could not invalidate any existing trace — the "additive-optional did not
  break the freeze" reasoning is sound. v1 traces validate under v2 (nothing
  became required); a v1-era validator fails a v2 trace only on `error`
  events, which would hit the "unknown or missing event type" branch. Correct
  as stated.
- **NIT:** `mode` _is_ required for `run.start` in `REQUIRED_BY_TYPE`, while
  optional on `EventBase`. The doc's "echoed onto every event" describes
  writer behaviour, not validation, and does not claim otherwise — but a
  half-sentence would prevent a reader from concluding validation enforces it.

## 5. Deployment + decisions — CONFIRMED

- `apps/web/vercel.json`: one cron, path `/api/maintenance/reset`, schedule
  `0 9 * * *` — matches "Vercel cron 09:00 UTC" and the arrow to
  `/api/maintenance/reset`.
- `createStore()` (store-redis.ts:99) returns `RedisStore` when
  `UPSTASH_REDIS_REST_URL`/`KV_REST_API_URL` + token are set, else a
  process-wide `InMemoryStore` singleton. Matches "two drivers behind one
  interface". The `globalThis` claim is real:
  `apps/web/src/lib/runtime.ts:4,19` anchors runtime singletons on
  `globalThis` with exactly the Next-bundling rationale the doc gives.
- **CI is key-free — CONFIRMED.** Three workflows: `ci.yml` (job
  `build-test`, header "Key-free by design: no ANTHROPIC_API_KEY exists
  anywhere in GitHub"), `eval-replay.yml` (job `replay`, "No
  ANTHROPIC_API_KEY, no secrets, no network"), `e2e.yml` (jobs `e2e` and
  `axe`, "no ANTHROPIC_API_KEY anywhere, not even as a secret"). The doc's
  "build-test · eval-replay · e2e · axe (all key-free)" is exact.
- **Nightly reset enumerates rather than scans — CONFIRMED**
  (`packages/pipeline/src/reset.ts:1-14`, "The Store interface has no key
  scan by design, so every surface is enumerated from known indexes"), which
  is what makes the shared Upstash DB safe. **NIT:** reset.ts explicitly does
  NOT clear per-IP rate and per-session counters (not enumerable; TTL-bounded).
  §4's "the nightly reset clears the demo" reads as total; a clause would fix it.
- **Decisions table — CONFIRMED against the design brief**
  (`~/clawd/lotus/demos/specs/demo4-design-brief-2026-08-10.html`):
  decision A ("SDK tool runner wrapped in an owned orchestrator, raw-loop
  fallback behind one interface (AGENT_LOOP=runner|raw)... Agent SDK and
  Managed Agents rejected"), C ("Zero new vendors; Langfuse cannot run on
  Vercel and the trace viewer should be part of the demo itself"), E ("three
  named bounded stores... BM25 retrieval over a policy KB, no vector DB").
  The doc's table restates all three fairly, without inflating them.
- `AGENT_LOOP=runner|raw` is real: `loop.ts:38` `DriverName`, :188 driver
  map, :193 `process.env.AGENT_LOOP ?? "runner"`, falling back to `"runner"`
  for any value other than `"raw"`.
- No vector DB: `retrieval.ts` is a dependency-free `Bm25Index`; no vector
  store anywhere. Memory stores are the three named ones (`memory.ts`
  `MEMORY_STORE_NAMES`, `VendorProfileStore`, `DedupeLedger`, plus run state
  in run-state.ts).
- Batch API for the matrix: `evals/runner/src/matrix/augment.script.ts` uses
  `client.messages.batches.*`. Matches "runs locally against the Batch API".
- `/eval` static claim: `apps/web/package.json` has
  `gen:eval-data` -> `scripts/generate-eval-data.mjs` writing
  `src/lib/eval-data.generated.ts`, with `src/lib/eval-data.test.ts` as the
  drift test. Matches.

## 6. Numbers — one REFUTED, rest CONFIRMED

| Claim                                                     | Verdict     | Evidence                                                              |
| --------------------------------------------------------- | ----------- | --------------------------------------------------------------------- |
| 73 golden cases                                           | CONFIRMED   | `ls evals/golden` = 73 files                                          |
| 73 byte-identical cassettes                               | CONFIRMED   | `evals/cassettes` = 73 JSON + README                                  |
| 22 held out (30%)                                         | CONFIRMED   | `evals/CASE-PLAN.md:28` "22 of 73 as built, 30%; floor is 20%"        |
| 9-document policy corpus                                  | CONFIRMED   | `packages/agent/kb/` = 9 .md files                                    |
| 24h run-state TTL                                         | CONFIRMED   | `RUN_STATE_TTL_SECONDS = 24 * 60 * 60`                                |
| P0 0.886 / 0.829 vs 0.900                                 | CONFIRMED   | BEFORE-AFTER.md numbers table + gates paragraph                       |
| INV-004 escaped containment                               | CONFIRMED   | BEFORE-AFTER.md "the finding"; skeptic2-findings.md H1                |
| Gates (P0 >= 0.90, guardrail hard zero, no P0 regression) | CONFIRMED   | `evals/thresholds.json`                                               |
| "55 of 56 attempts held" (§6 caveat)                      | CONFIRMED   | 28/29 uncached + 27/27 cached = 55/56                                 |
| **"56 deployed-tier cases"** (§6 decisions table)         | **REFUTED** | see below                                                             |
| "no aggregate drop" (§8)                                  | IMPRECISE   | gate is `aggregate_drop_max_points: 2` — a drop up to 2 points passes |

**BLOCKING — "56 cases" is not what was measured.** §6 says "the model
attempted to bypass the approval path on **56 deployed-tier cases**"; client
§2 says "on **56 test cases**". The record (BEFORE-AFTER.md, skeptic2 H1) is
**56 attempts across two deployed-tier lanes** — 29 uncached + 27 cached over
the same 73-case set. There are only **41 execution-forbidden goldens per
lane**, so 56 distinct cases is arithmetically impossible. The doc's own §6
caveat sentence ("55 of 56 attempts") and client §5 ("measured at 56
attempts") get it right, so the pair is internally inconsistent. Fix: say
"56 attempts across the two deployed-tier lanes (29 uncached + 27 cached)".

## 7. Client-doc honesty — PLAUSIBLE, two overstatements to fix

Good, and worth keeping: the fictional-demo framing is unmissable (opening
callout box, the "For your engagement" annotations, the closing footer). The
INV-004 narrative in §5 matches skeptic2-findings.md H1 exactly — invented PO
reference, wrongly routed `auto_approve` under the $500 autonomy cap,
simulated execution completed, gate behaved as designed because it reads the
disposed route. The architectural lesson stated ("a gate bounds the damage of
the routes it can see") is the same conclusion H1 reaches. That section is
the strongest part of the document and is accurate.

Findings:

- **BLOCKING — "the overall correctness gate still fails: 0.886 and 0.829"
  (§5) mislabels the metric.** 0.886/0.829 are the **P0 pass rates**. The
  overall pass rates are 80.8% (59/73) and 79.5% (58/73). Calling P0
  "overall correctness" makes the system look ~8 points better than the
  measured aggregate, in the one section whose whole point is not flattering
  the result. Fix: "the P0 correctness gate still fails: 0.886 and 0.829
  against a 0.900 minimum (overall pass rate 80.8% / 79.5%)".
- **NON-BLOCKING — "What remains is the agent being _too conservative_"
  overstates.** BEFORE-AFTER.md residuals: 8 of 14 uncached failures are
  wrong-conservative routes (TOOL-001); the rest are 2x FMT, 1x SYS-003,
  1x EXT-001, 1x EXT-003, 1x TOOL-004. Say "the largest remaining class".
- **NON-BLOCKING — "eliminated (0)" without the scope disclosure.**
  BEFORE-AFTER.md states plainly: 2 of 6 matrix lanes, one run per lane,
  sonnet/opus not re-measured. skeptic2 H3 called out publishing "eliminated"
  without that disclosure. Client §5 scopes to "the deployed model", which is
  most of the fix, but neither doc says "one run per lane, deployed tier
  only". One clause in each.
- **NON-BLOCKING — "Nothing in the system is allowed to turn a hard one into
  an easy one" (§1) is contradicted by §5.** INV-004 is precisely a hard one
  becoming an easy one. Soften to "no component may reclassify a hard one as
  easy without leaving a record" or forward-reference §5.
- **NON-BLOCKING — "Every field is quoted / the agent may not report a value
  it cannot point at on the page" is prompt-enforced, not code-enforced.**
  `extraction.ts` requires a `source_spans` map in the schema, but nothing
  verifies the quoted span actually occurs in the document text; the
  discipline lives in `prompts.ts` (CITATIONS AND EVIDENCE, plus the 1.3.0
  EXT-003 PO guard). INV-004 is the proof it can fail. In a document whose
  organizing contrast is "code, not prompt", this claim should say which
  side of that line it is on.
- **NIT — §5 "re-measured on the same 73 cases under the same rubric"** is
  right (amendment-13 goldens on both sides, 1.2.0 regraded at zero cost),
  but "same rubric" is doing quiet work: the rubric _moved_ and the old side
  was regraded to match. The engineering doc explains this in §8
  (`matrix:regrade`); one clause in the client doc would pre-empt the
  obvious question.

---

## Ranked

**Blocking (fix before showing a prospect)**

1. `docs/architecture.md` §6 "56 deployed-tier cases" and
   `03-architecture.md` §2 "56 test cases" -> 56 _attempts_ across two lanes.
2. `03-architecture.md` §5 "overall correctness gate" -> P0 pass rate; add
   the true overall (80.8% / 79.5%).

**Non-blocking**

3. Component view omits `/api/approvals/[id]` and
   `/api/runs/[id]/trace.jsonl`.
4. §8 "no aggregate drop" vs the 2-point allowance in thresholds.json.
5. "too conservative" as the whole residual (it is 8 of 14).
6. "eliminated (0)" without the one-run / 2-of-6-lane scope note.
7. §1 "nothing can turn a hard one into an easy one" vs §5.
8. "every field is quoted" is prompt+schema, not code-verified.

**Nits**

9. `/admin` is a route handler, not a page.
10. Sequence hides the shadow-mode and existing-approval branches of GR-EXEC.
11. `kb_search` / `update_vendor_profile` absent from the sequence;
    containment/extraction/pricing absent from the component view.
12. `mode` required for `run.start` though optional on `EventBase`.
13. §4 "the nightly reset clears the demo" — rate/session counters are
    deliberately not cleared.

**Verdict: FIX-FIRST** (items 1 and 2 only; everything structural in both
documents holds up against the source).

_Review by fresh-context skeptic, read-only against the working tree._
