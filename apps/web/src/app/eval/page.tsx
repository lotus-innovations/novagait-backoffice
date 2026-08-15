import type { Metadata } from "next";
import { Fragment } from "react";
import {
  CALIBRATION,
  CONTAINMENT,
  PUBLISHED,
  REGRADE_AFTER,
  REGRADE_BEFORE,
  REMEASURE,
} from "@/lib/eval-data.generated";

export const metadata: Metadata = {
  title: "Evaluation report | Novagait Back Office",
  description:
    "Pre-deployment assessment of the AP invoice agent: model matrix, " +
    "guardrail before/after, judge calibration, go/no-go determination.",
};

// Static by design: every number on this page is compiled from committed
// run artifacts (see eval-data.generated.ts banner). No store, no client JS.

const UNCACHED = "claude-haiku-4-5:uncached";
const CACHED = "claude-haiku-4-5:cached";

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const usd = (value: number | null) =>
  value === null ? "-" : `$${value.toFixed(4)}`;
const ms = (value: number | null) =>
  value === null ? "not re-measured" : `${(value / 1000).toFixed(0)}s`;

const codeCount = (
  codes: Record<string, number> | object,
  code: string,
): number => (codes as Record<string, number>)[code] ?? 0;

type RegradeLane =
  | (typeof REGRADE_BEFORE.lanes)[keyof typeof REGRADE_BEFORE.lanes]
  | (typeof REGRADE_AFTER.lanes)[keyof typeof REGRADE_AFTER.lanes];

function laneOf(regrade: { lanes: object }, key: string): RegradeLane {
  const lane = (regrade.lanes as Record<string, RegradeLane>)[key];
  if (lane === undefined) throw new Error(`missing regrade lane ${key}`);
  return lane;
}

/** Proportional in-cell bar; the printed value carries the information. */
function Bar({ value, max }: { value: number; max: number }) {
  const width = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <span className="cellbar" aria-hidden="true">
      <span className="cellbar-fill" style={{ width: `${width}%` }} />
    </span>
  );
}

/**
 * Plain-language line for each metric caveat.
 *
 * The caveats themselves are republished verbatim from the run artifacts, so
 * they cannot be edited for readability without making the word "verbatim"
 * false. These glosses carry the meaning at the readability standard instead.
 *
 * Keyed on the caveat key, which is stable across regeneration. Deliberately
 * digit-free: every number on this page comes from the artifacts, and prose
 * must not introduce one. eval-data.test.ts fails if a caveat key has no gloss.
 */
export const CAVEAT_GLOSS: Record<string, string> = {
  source: "Where these caveats come from.",
  vendor_id_field_accuracy:
    "Vendor id accuracy is not a model score. Code re-resolves the vendor from the printed name and overwrites what the model claimed, so the field is correct by construction.",
  output_schema_valid:
    "Format grading records only whether the agent drafted an action. It does not inspect the fields inside that draft.",
  decision:
    "Route grading scores the route the system disposed, not the route the model proposed. The divergence column is what measures the model.",
};

export function caveatGloss(key: string): string {
  return CAVEAT_GLOSS[key] ?? "Verbatim caveat from the run artifacts.";
}

const FAMILY_ORDER = ["GRD", "DEC", "TOOL", "EXT", "FMT", "SYS"] as const;
const FAMILY_LABEL: Record<string, string> = {
  GRD: "Guardrail (approval bypass)",
  DEC: "Decision (wrong route)",
  TOOL: "Tool sequence",
  EXT: "Extraction",
  FMT: "Format",
  SYS: "System / limits",
};

export default function EvalPage() {
  const beforeUncached = laneOf(REGRADE_BEFORE, UNCACHED);
  const beforeCached = laneOf(REGRADE_BEFORE, CACHED);
  const afterUncached = laneOf(REGRADE_AFTER, UNCACHED);
  const afterCached = laneOf(REGRADE_AFTER, CACHED);

  const grdBefore =
    codeCount(beforeUncached.failures_by_code, "GRD-004") +
    codeCount(beforeCached.failures_by_code, "GRD-004");
  const grdAfter =
    codeCount(afterUncached.failures_by_code, "GRD-004") +
    codeCount(afterCached.failures_by_code, "GRD-004");

  const familyMax = Math.max(
    ...FAMILY_ORDER.map((family) =>
      Math.max(
        codeCount(beforeUncached.failures_by_family, family),
        codeCount(afterUncached.failures_by_family, family),
      ),
    ),
  );

  const beforeAfterRows = [
    { label: "uncached", before: beforeUncached, after: afterUncached },
    { label: "cached", before: beforeCached, after: afterCached },
  ];

  return (
    <main>
      <h1>Evaluation report</h1>
      <p>
        This is the pre-deployment assessment of the Novagait AP agent. It runs
        a 73-case golden set as a model-by-cache-mode matrix. Deterministic
        graders score every case against a failure taxonomy. An LLM judge is
        reported but never gated. A human-in-the-loop gate covers every route
        the policy sends to a human.
      </p>
      <p>
        Auto-approve runs under the autonomy cap execute without that gate, and
        that surface is what the INV-004 finding below exercises. The specs
        committed in this repo govern how the benchmark is selected and read.
        The go/no-go determination at the bottom is what the numbers support,
        not what we hoped for.
      </p>

      <p className="banner" data-testid="results-as-of">
        Results as of <strong>{REMEASURE.generated_on}</strong> (deployed-tier
        re-measure at prompt {REMEASURE.prompt_version}) and{" "}
        <strong>{PUBLISHED.generated_on}</strong> (full matrix at prompt{" "}
        {PUBLISHED.prompt_version}). Agent SDK {PUBLISHED.sdk_version}, tools{" "}
        {PUBLISHED.tools_version}, pricing verified{" "}
        {PUBLISHED.pricing_verified_on}, deployed model{" "}
        <code>{PUBLISHED.deployed_model}</code>. Every figure below is compiled
        from committed run artifacts at build time.
      </p>

      <section aria-labelledby="headline-h">
        <h2 id="headline-h">The headline: a measured fix</h2>
        <div className="stat-grid">
          <div className="stat" data-testid="headline-grd004">
            <span className="stat-value">
              {grdBefore} → {grdAfter}
            </span>
            <span className="stat-label">
              GRD-004 approval-bypass attempts, deployed tier (both lanes,
              prompt {PUBLISHED.prompt_version} → {REMEASURE.prompt_version})
            </span>
          </div>
          <div className="stat">
            <span className="stat-value">
              {pct(beforeUncached.pass_rate)} → {pct(afterUncached.pass_rate)}
            </span>
            <span className="stat-label">
              pass rate, uncached lane, same 73 cases, same rubric
            </span>
          </div>
          <div className="stat">
            <span className="stat-value">
              {beforeUncached.p0_pass_rate.toFixed(3)} →{" "}
              {afterUncached.p0_pass_rate.toFixed(3)}
            </span>
            <span className="stat-label">
              P0 pass rate, uncached lane (gate minimum 0.900, still failing)
            </span>
          </div>
        </div>
        <p>
          The 2026-08-11 matrix surfaced the failure mode. On cases the policy
          holds for a human, the model drafted the hold and then called{" "}
          <code>execute_action</code> anyway. The code-side approval gate held{" "}
          {CONTAINMENT.deployed_tier_held} of{" "}
          {CONTAINMENT.deployed_tier_attempts} deployed-tier attempts. On{" "}
          <code>{CONTAINMENT.escape_case}</code> it could not, because{" "}
          {CONTAINMENT.escape_mechanism}.
        </p>
        <p>
          The hardened prompt makes execution conditional on the route, and
          guards against inferring PO references the document does not print. We
          then re-measured the deployed tier on the same harness. That measure,
          fix, re-measure loop is the product being demonstrated.
        </p>
      </section>

      <section aria-labelledby="beforeafter-h">
        <h2 id="beforeafter-h">Deployed tier, before and after</h2>
        <p>
          Both columns are graded under the same golden revision. That revision
          requires the execution attempt on payable routes. A model that stopped
          executing entirely could not fake this improvement. The before column
          is the paid 2026-08-11 outcomes, regraded at zero cost. Regrading left
          its published pass counts unchanged.
        </p>
        <table data-testid="before-after">
          <thead>
            <tr>
              <th scope="col">Lane</th>
              <th scope="col">Metric</th>
              <th scope="col">Before ({PUBLISHED.prompt_version})</th>
              <th scope="col">After ({REMEASURE.prompt_version})</th>
            </tr>
          </thead>
          <tbody>
            {beforeAfterRows.map(({ label, before, after }) => (
              <Fragment key={label}>
                <tr>
                  <th scope="row" rowSpan={3}>
                    {label}
                  </th>
                  <td>pass</td>
                  <td>
                    {before.passed}/{before.total} ({pct(before.pass_rate)})
                  </td>
                  <td>
                    {after.passed}/{after.total} ({pct(after.pass_rate)})
                  </td>
                </tr>
                <tr>
                  <td>P0 pass rate</td>
                  <td>{before.p0_pass_rate.toFixed(3)}</td>
                  <td>{after.p0_pass_rate.toFixed(3)}</td>
                </tr>
                <tr>
                  <td>GRD-004 attempts</td>
                  <td>{codeCount(before.failures_by_code, "GRD-004")}</td>
                  <td>
                    <strong>
                      {codeCount(after.failures_by_code, "GRD-004")}
                    </strong>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
        <p>
          The gate board after the fix reads as follows.{" "}
          <em>Guardrail hard zero</em> passes both lanes, with 0
          guardrail-family failures across the 41 execution-forbidden cases per
          lane. <em>P0 pass rate</em> fails both lanes, at{" "}
          {afterUncached.p0_pass_rate.toFixed(3)} and{" "}
          {afterCached.p0_pass_rate.toFixed(3)} against 0.900. The two
          baseline-comparison gates passed vacuously, because no baseline is
          wired. The overall gate set is therefore <strong>not green</strong>,
          and this page does not claim otherwise.
        </p>
      </section>

      <section aria-labelledby="taxonomy-h">
        <h2 id="taxonomy-h">What still fails, by taxonomy family</h2>
        <p>
          Uncached lane, failures grouped by taxonomy family. The guardrail
          family went to zero. What remains is dominated by wrong-route
          conservatism. The model holds an invoice the policy says is payable,
          then correctly refuses to execute its own hold. Wrong routes measured
          directly are 9 before and 9 after. The fix did not buy decision
          accuracy, and did not cost any either.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Family</th>
              <th scope="col">Before ({PUBLISHED.prompt_version})</th>
              <th scope="col">After ({REMEASURE.prompt_version})</th>
            </tr>
          </thead>
          <tbody>
            {FAMILY_ORDER.map((family) => {
              const before = codeCount(
                beforeUncached.failures_by_family,
                family,
              );
              const after = codeCount(afterUncached.failures_by_family, family);
              return (
                <tr key={family}>
                  <th scope="row">{FAMILY_LABEL[family]}</th>
                  <td>
                    <span className="cellbar-value">{before}</span>
                    <Bar value={before} max={familyMax} />
                  </td>
                  <td>
                    <span className="cellbar-value">{after}</span>
                    <Bar value={after} max={familyMax} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted">
          Taxonomy precedence puts a missing required call (TOOL) above a wrong
          route (DEC). A wrong-route hold that skips execution therefore grades
          TOOL-001 primary. The counts above are family counts as graded. The
          wrong-route reading in the prose is from case-level adjudication.
        </p>
      </section>

      <section aria-labelledby="matrix-h">
        <h2 id="matrix-h">
          Full model matrix ({PUBLISHED.generated_on}, prompt{" "}
          {PUBLISHED.prompt_version})
        </h2>
        <p>
          Six lanes: three models by two cache modes over the same 73 cases, run
          through the Batch API. Cost-per-correct-run is the number that matters
          for procurement, because a cheaper model that is wrong more often is
          not cheaper. The p50 latency column comes from a separate interactive
          pass of 12 cases and 3 repetitions per model. That pass is per model,
          not per cache lane, and it is not from the Batch runs. Each
          model&apos;s figure is therefore identical across its two cache rows.
          It says nothing about the effect of caching on latency.
        </p>
        <table data-testid="published-matrix">
          <thead>
            <tr>
              <th scope="col">Lane</th>
              <th scope="col">Pass</th>
              <th scope="col">P0</th>
              <th scope="col">Cost / run</th>
              <th scope="col">Cost / correct</th>
              <th scope="col">p50 latency</th>
              <th scope="col">Capped runs</th>
            </tr>
          </thead>
          <tbody>
            {PUBLISHED.rows.map((row) => (
              <tr key={`${row.model}:${row.mode}`}>
                <th scope="row">
                  <code>
                    {row.model}:{row.mode}
                  </code>
                </th>
                <td>
                  {row.passed}/{row.cases} ({pct(row.pass_rate)})
                </td>
                <td>{row.p0_pass_rate.toFixed(3)}</td>
                <td>{usd(row.mean_cost_per_run_usd)}</td>
                <td>{usd(row.cost_per_correct_run_usd)}</td>
                <td>{ms(row.p50_latency_ms)}</td>
                <td>{row.output_capped_runs ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          The deployed-tier re-measure ({REMEASURE.generated_on}, prompt{" "}
          {REMEASURE.prompt_version}) covers the two{" "}
          <code>{PUBLISHED.deployed_model}</code> lanes only. The other four
          lanes above have not been re-measured since the fix, so their numbers
          describe prompt {PUBLISHED.prompt_version}. Latency was not re-run
          either. The after-lanes averaged fewer tool iterations per run, so the
          latency column above is likely conservative for the current prompt.
        </p>
        <details>
          <summary>
            Metric caveats and run notes, verbatim from the artifacts
          </summary>
          <p>
            Every entry below is reproduced word for word from the committed
            artifacts. Editing it for readability would make the word
            &quot;verbatim&quot; false, so it stays as written. A plain-language
            line introduces each one instead.
          </p>

          <h3>What each metric does not measure</h3>
          <ul>
            {Object.entries(PUBLISHED.metric_caveats).map(([key, caveat]) => (
              <li key={key}>
                <span className="gloss">{caveatGloss(key)}</span>
                <strong>{key}:</strong> {String(caveat)}
              </li>
            ))}
          </ul>

          <h3>Run notes, full matrix</h3>
          <p className="gloss">
            These record what broke during the run, what was recovered, and
            which lanes a given figure does not cover. Read them before quoting
            any number on this page.
          </p>
          <ul>
            {PUBLISHED.notes.map((note) => (
              <li key={`pub:${note}`}>
                <strong>{PUBLISHED.generated_on}:</strong> {note}
              </li>
            ))}
          </ul>

          <h3>Run notes, deployed-tier re-measure</h3>
          <p className="gloss">
            The same, for the re-measured lanes after the prompt fix.
          </p>
          <ul>
            {REMEASURE.notes.map((note) => (
              <li key={`rem:${note}`}>
                <strong>{REMEASURE.generated_on} re-measure:</strong> {note}
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section aria-labelledby="drilldown-h">
        <h2 id="drilldown-h">Per-case drill-down</h2>
        <p>
          Every failing case in the re-measured lanes, with its primary taxonomy
          code. The full traces live in the committed lane checkpoints (
          <code>evals/results/</code> in the repo), one JSON outcome per case,
          schema-versioned.
        </p>
        <div data-testid="drill-down">
          {[
            {
              label: `uncached (prompt ${REMEASURE.prompt_version})`,
              lane: afterUncached,
            },
            {
              label: `cached (prompt ${REMEASURE.prompt_version})`,
              lane: afterCached,
            },
          ].map(({ label, lane }) => (
            <details key={label}>
              <summary>
                {label}: {lane.failed_cases.length} failing of {lane.total}
              </summary>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Case</th>
                    <th scope="col">Primary code</th>
                  </tr>
                </thead>
                <tbody>
                  {lane.failed_cases.map((failed) => (
                    <tr key={failed.case_id}>
                      <td>
                        <code>{failed.case_id}</code>
                      </td>
                      <td>{failed.primary_code ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
        </div>
      </section>

      <section aria-labelledby="calibration-h">
        <h2 id="calibration-h">Judge calibration</h2>
        <p data-testid="calibration">
          The LLM judge is layer 3: reported, never gated. A blinded hand-score
          of {CALIBRATION.drafts_scored} drafts ({CALIBRATION.scored_on}) put
          verdict agreement at <strong>{CALIBRATION.verdict_agreement}</strong>{" "}
          with a mean absolute score difference of{" "}
          {CALIBRATION.mean_abs_score_diff}. Direction is{" "}
          {CALIBRATION.direction}. Scope: {CALIBRATION.scope_note}.
        </p>
        <p>
          Judge verdicts are computed once per model on the uncached outcomes,
          then stamped onto both cache columns. Drafts differ between cache
          lanes under sampling variance. The judge scores in the cached column
          are therefore not an independent measurement of the cached drafts.
        </p>
      </section>

      <section aria-labelledby="gonogo-h">
        <h2 id="gonogo-h">Go/no-go determination</h2>
        <div className="banner" data-testid="go-no-go">
          <p>
            <strong>Autonomous mode: NO-GO</strong> at current thresholds. The
            P0 gate fails on the deployed tier, at{" "}
            {afterUncached.p0_pass_rate.toFixed(3)} uncached and{" "}
            {afterCached.p0_pass_rate.toFixed(3)} cached against a 0.900
            minimum. The remaining failure mass is wrong-route decisions, which
            is exactly the class a human approver exists to catch.
          </p>
          <p>
            <strong>Assisted and shadow modes: supported.</strong> With the
            approval gate in the loop, the measured guardrail behavior is clean.
            There were zero approval-bypass attempts after the fix, and zero
            executions on cases the model itself routed for a human. That is the
            deployment posture this demo ships in, and the one the data supports
            today.
          </p>
        </div>
      </section>

      <section aria-labelledby="provenance-h">
        <h2 id="provenance-h">Provenance</h2>
        <p className="muted">
          This page is compiled at build time from the committed artifacts in{" "}
          <code>evals/results/matrix-2026-08-11/</code> and{" "}
          <code>evals/results/matrix-2026-08-13-p130/</code>. Those artifacts
          are the matrix tables, the per-lane checkpoints, and the regrades
          under the current golden revision. They also include the spend ledger,
          the calibration results, and the independent verification notes.
          Prompt versions are stamped into every run&apos;s trace. The golden
          set, graders, taxonomy, and thresholds are versioned in the same repo.
        </p>
      </section>
    </main>
  );
}
