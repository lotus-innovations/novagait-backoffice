# LOT-109 review: /eval published report page (commit a8a27b4)

Skeptical fresh-context review of the new static `/eval` route, its generator,
its compiled data module and its tests, against the committed artifacts.
Read-only except this file. `npx vitest run apps/web/src/lib/eval-data.test.ts`
= 4 passed; `npm run typecheck -w web` = clean.

Overall: **SHIP WITH FIXES** (no blocker on any published number; two
disclosure items and one render defect should land before this is shown to a
paying reader).

---

## 1. DATA CHAIN - PASS, with two gaps

Faithfulness of the projection: `slimMatrix` and `slimRegrade` copy fields
under their source names with no arithmetic, no renaming, no unit changes.
`slimRegrade` lifts `lane.summary.*` up one level (`summary.passed` ->
`passed`), which is a flattening, not a transform. Every value the page prints
resolves to a committed JSON field or to one of the two hand-authored
constants below. Verified against the artifacts:

- `PUBLISHED` = matrix-2026-08-11/matrix.json, 6 rows, all fields identical.
- `REGRADE_BEFORE/AFTER` = the two regrade JSONs; before uncached GRD-004 = 29,
  before cached = 27, after lanes carry no `GRD` key at all.
- Headline `56 -> 0` is computed as 29 + 27 (both deployed lanes), which is the
  same 56 denominator as `CONTAINMENT.deployed_tier_attempts`. Internally
  consistent.

**CONTAINMENT (55 of 56): VALUES CONFIRMED.** skeptic2-findings.md H1 gives
haiku uncached 29 attempts / 1 executed (INV-004) and haiku cached 27 / 0.
28 + 27 = 55 held of 56 attempts. The escape mechanism string matches H1 and
BEFORE-AFTER.md (wrong route to `auto_approve` under the $500 cap, gate keys
off the disposed route). `escape_case` INV-004 confirmed.

**CALIBRATION: VALUES CONFIRMED.** calibration-results.md gives verdict
agreement 7/12, mean abs diff 0.2308, 12 drafts, scored 2026-08-13, and all
five disagreements have the judge scoring below the human ("the judge never
scored a draft above the human's read"). `scope_note` (1.2.0 drafts; unscored
1.3.0 worksheet exists) matches skeptic2 H5.

Gap A (non-blocking): `verifyContainmentAnchors` checks only the substrings
`28/29`, `INV-004`, `terminal_state`. Nothing pins the cached lane's `27/27`
or the derived `55`/`56`. If a re-verification moved the cached number, the
generator would still emit 55/56 silently. Add `27` / `27/27` (or better,
recompute containment from the checkpoints) to the anchor list.

Gap B (non-blocking): the anchor checks run only at generation time. The drift
test verifies `CALIBRATION` against calibration-results.md but never touches
`CONTAINMENT`, so the page's most safety-critical sentence has zero CI
coverage.

Gap C (nit): four numbers on the page are prose literals, not artifact-derived:
`73`-case (x2), the `41` execution-forbidden cases, the `0.900` gate minimum
(x3), and `9 before, 9 after`. All four are correct as written (41 and 9/9 are
both from skeptic2 Claim 3/Claim 4, verified there), but none is drift-tested.

## 2. PAGE HONESTY - PASS on the items flagged, one overstatement found

Confirmed accurate:
- "9 before, 9 after" wrong routes: matches BEFORE-AFTER.md and skeptic2
  Claim 3 (9 at 1.2.0 vs 9 at 1.3.0, uncached). The paragraph is explicitly
  scoped "Uncached lane" in its first sentence, and the follow-on `.muted`
  paragraph correctly explains the TOOL-over-DEC precedence masking. Honest.
- Gate board: names both real gates with the right verdicts, names the two
  vacuous baseline gates, and states the overall set is not green. Matches
  skeptic2 Claim 4 including its omission item.
- 2-of-6-lane scope limitation: stated in prose ("covers the two
  claude-haiku-4-5 lanes only; the other four lanes above have not been
  re-measured"), and the verbatim REMEASURE note "INCOMPLETE MATRIX: 2 of 6
  lanes are present" also renders in the caveats `<details>`. Satisfied.
- Judge stamping disclosure: present and accurate (skeptic2 H2).
- Latency re-measure wording: matches skeptic2 H4's recommendation exactly
  (drops the unmeasured expectation, cites the iteration delta). Good.
- Go/no-go: "zero executions on cases the model itself routed for a human" -
  independently recomputed from the p130 checkpoints: model_route =
  `route_for_approval` -> 9 cases uncached, 7 cached, `terminal_state
  "executed"` in 0 of them. CONFIRMED.

**Finding H-1 (should fix, honesty).** Opening paragraph: "...and a
human-in-the-loop gate at every material decision point in the product
itself." That is not what the artifacts show. The approval gate keys off the
disposed route, so `auto_approve` runs under the $500 autonomy cap execute
with no human: 14 cases reached `terminal_state "executed"` on the after
uncached lane and 13 on the cached lane. The page contradicts itself two
paragraphs later when it explains exactly this as the INV-004 escape path.
Suggested: "...and a human-in-the-loop gate on every route the policy sends to
a human (auto-approve runs under the autonomy cap execute without one - see
INV-004 below)."

**Finding H-2 (should fix, disclosure).** The matrix table publishes a "p50
latency" column per lane, inside a section whose prose says the six lanes were
"run through the Batch API". The latency numbers are neither per-lane nor from
those runs: `matrix-2026-08-11/latency.json` is a separate serial pass over 12
cases x 3 repetitions with no `mode` field, so each model's p50/p95 is
duplicated onto both of its cache lanes (haiku 17946 on both, sonnet 21772 on
both, opus 41012 on both). Rendered as-is, the column tells a reader that
prompt caching does not reduce latency, which is an artifact of the
measurement, not a result. None of the rendered `metric_caveats` covers this
(they cover source, vendor_id, output_schema, decision). Add one clause: p50/p95
are from a 12-case x 3-rep interactive latency pass per model, not from the
Batch lanes, and are therefore identical across cache modes.

**Finding H-3 (nit).** "No store, no client JS" is a source comment, not page
prose, and is true of this route's own code (no `use client`, no hooks, inline
`style` only). Next.js still ships its framework runtime, so if that phrase
ever migrates into user-visible copy it needs softening to "no client-side data
fetching".

## 3. RENDER CORRECTNESS - one real defect

**Finding R-1 (should fix, duplicate React keys + duplicated content).** In the
caveats `<details>`, `PUBLISHED.notes` and `REMEASURE.notes` are mapped into the
SAME `<ul>` with `key={note}`. Seven note strings are byte-identical between the
two arrays (the divergence-broken note, the calibration-not-here note, the
short-circuit note, the batch-progress note, the NO-MOCK-BASELINE note, the
RUN-LOG note, and the Reviewer N3 note). That is 7 duplicate keys in one list
plus 7 verbatim repeated bullets, in the section that exists to demonstrate
rigor. Fix: dedupe on merge, or key/label them by source
(`key={`pub:${note}`}` / `key={`rem:${note}`}`) and prefix each group with its
directory so a reader knows which run a note belongs to. No collision between
`metric_caveats` keys and note strings (checked).

Everything else checks out:
- Fragment rows: `<th scope="row" rowSpan={3}>` + 3 `<td>` on row 1, 3 `<td>` on
  rows 2 and 3, table is 4 columns. Alignment correct.
- `Bar`: `max === 0` guarded; `familyMax` is the max over the same two series the
  table renders, so `value > max` is unreachable. `aria-hidden` with the numeric
  value printed alongside. Correct.
- `codeCount` on absent keys: `?? 0`, exercised for real (after lanes have no
  `GRD` family and no `GRD-004` code, DEC/SYS absent in the cached after lane).
- `pct` / `usd` / `ms` null handling: no rendered field is actually null.
  All six PUBLISHED rows carry non-null cost and latency, so `usd`'s "-" and
  `ms`'s "not re-measured" branches are dead code on current data. Note that
  "not re-measured" would be the wrong wording if a never-measured lane ever
  rendered (nit).
- `output_capped_runs ?? 0` is defensive but the field is present on all rows
  (0/1/3/6/30/25).
- Other keys unique: 6 matrix `model:mode` rows, 14 and 15 distinct
  `case_id`s in the two drill-down tables, 2 distinct `<details>` labels.
- `model_policy_divergence` is slimmed but never rendered - harmless, though
  it is the one metric the notes spend the most words on.

## 4. TESTS - PARTIAL PASS

The drift test does read the source JSONs and compare field by field, so it is
a genuine drift gate, not a snapshot of itself. It passes (4/4). But its
coverage is narrower than what the page renders:

- PUBLISHED: checks generated_on, prompt_version, sdk_version,
  pricing_verified_on, row count, and per row model/mode/passed/pass_rate/
  p0_pass_rate/cost_per_correct. **Not checked, but rendered:**
  `deployed_model`, `tools_version`, `cases`, `mean_cost_per_run_usd`,
  `p50_latency_ms`, `output_capped_runs`, `metric_caveats`, `notes`.
  A change to the cost/run or latency column in the artifact would ship to the
  page with a green CI.
- REMEASURE: only prompt_version, generated_on and the [mode, passed] pairs.
  `notes` (rendered verbatim, including the INCOMPLETE-MATRIX disclosure) is
  unchecked.
- Regrade: checks passed, p0_pass_rate, both failure maps, `gates`, and
  `failed_cases.length` - but not `total`, not `pass_rate`, and not the
  contents of `failed_cases`. The per-case drill-down table renders exactly
  those contents, so a changed case id or primary code is invisible to CI.
- `CONTAINMENT` has no test at all (see Gap B).
The explicit GRD-004 pins (29, and `"GRD-004" in ... === false`) are the right
idea and are the strongest assertions in the file.

e2e spec: asserts real content (banner stamps 2026-08-13 and SDK 0.115.0, both
prompt versions in the before/after table, 7 rows in the matrix, `claude-opus-5`
present, /no-go/i, calibration 7/12, INV-021 in the drill-down). That is a real
smoke test, not a title check. One weak assertion:
`getByTestId("headline-grd004")).toContainText("0")` passes on any string
containing a zero, including "56 -> 10". Assert the pair, e.g. `/56\s*.\s*0$/`
or `toContainText("56")` plus a `not.toContainText("GRD-004: 1")`-style guard.

Axe addition: correctly scoped. It force-opens every `<details>` before
scanning, which is the right call since collapsed content is unreachable to the
scanner, and it sits inside the existing `@axe` describe so it runs under
`e2e:axe` only.

## 5. A11Y / SPEC-12 - PASS

- Every `<section>` carries `aria-labelledby` pointing at a real `<h2 id>`;
  ids are unique across the page. Single `<h1>`, no heading level skips.
- All five tables use `<th scope="col">` headers and `<th scope="row">` row
  headers; the before/after table's `rowSpan={3}` row header is the correct
  construct for its grouping.
- The decorative bar is `aria-hidden="true"` with the numeric value rendered as
  text, so the table is complete to a screen reader.
- No client JS on the route (no `use client`, no hooks, no event handlers);
  `<details>`/`<summary>` provide disclosure natively.
- The synthetic-data disclaimer footer is inherited from `layout.tsx` and
  applies to `/eval` like every other route. Nav link added.
- Nit: none of the five tables has a `<caption>`. Axe will not flag it, but a
  caption is the cheapest a11y upgrade here given the page is table-heavy.

---

## Ranked

**Blocking:** none. No published number is wrong; the 55/56 correction and the
calibration figures are both supported by their anchor files, and every claim
BEFORE-AFTER.md was verified on carries through accurately.

**Should fix before this is shown to a client:**
1. H-1 - "human-in-the-loop gate at every material decision point" is
   contradicted by the page's own INV-004 explanation and by 14/13 autonomous
   executions in the after lanes.
2. H-2 - the p50 latency column is a per-model, 12-case, 3-rep, non-Batch
   measurement presented as a per-lane Batch metric, with no caveat.
3. R-1 - 7 duplicate React keys and 7 duplicated bullets in the caveats list.

**Non-blocking:**
4. Gap A/B - containment anchors do not pin 27/27 or 55/56, and no test covers
   CONTAINMENT.
5. Drift test does not cover several rendered fields (cost/run, latency,
   capped runs, caveats, notes, failed_cases contents, total).
6. Weak `headline-grd004` e2e assertion.

**Nits:** hardcoded prose numerals (73/41/0.900/9-9); `ms()` null wording;
missing `<caption>`s; unrendered `model_policy_divergence`; "no client JS"
comment.

Provenance: reviewed 2026-08-14 against commit a8a27b4 (diff vs 3804591).
Sources: apps/web/{scripts/generate-eval-data.mjs, src/app/eval/page.tsx,
src/lib/eval-data.{generated.ts,test.ts}, e2e/{eval-report,axe}.spec.ts,
src/app/layout.tsx}; evals/results/matrix-2026-08-11/{matrix.json,
regrade-under-current-goldens.json, calibration-results.md, latency.json};
evals/results/matrix-2026-08-13-p130/{matrix.json,
regrade-under-current-goldens.json, BEFORE-AFTER.md, skeptic2-findings.md,
checkpoint-claude-haiku-4-5-{uncached,cached}.json}. Tests run: vitest drift
suite (4 passed), tsc --noEmit (clean). Read-only; no git operations.
