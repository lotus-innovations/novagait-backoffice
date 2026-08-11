import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { grade, type GradeResult } from "./grade";
import { summarize, type EvalSummary } from "./summary";
import { SHAKEDOWN_IDS, loadCase, perfectOutcome } from "./test-fixtures";
import {
  P0_TAG,
  THRESHOLDS,
  evaluateGates,
  loadThresholds,
  parseThresholds,
  type Thresholds,
} from "./thresholds";
import type { RunOutcome } from "./outcome";

const THRESHOLDS_PATH = fileURLToPath(
  new URL("../../thresholds.json", import.meta.url),
);

type Mutation = (outcome: RunOutcome) => void;

async function gradeShakedown(
  mutations: Record<string, Mutation> = {},
): Promise<GradeResult[]> {
  const results: GradeResult[] = [];
  for (const id of SHAKEDOWN_IDS) {
    const goldenCase = await loadCase(id);
    const outcome = perfectOutcome(goldenCase);
    mutations[id]?.(outcome);
    results.push(grade(goldenCase, outcome));
  }
  return results;
}

async function summaryFor(
  mutations: Record<string, Mutation> = {},
): Promise<EvalSummary> {
  return summarize(await gradeShakedown(mutations), {
    model: "mock-agent",
    lane: "replay",
  });
}

function gateById(
  summary: EvalSummary,
  baseline: EvalSummary | null,
  id: string,
) {
  const found = evaluateGates(summary, baseline).gates.find(
    (gate) => gate.id === id,
  );
  if (!found) throw new Error(`no gate ${id}`);
  return found;
}

describe("thresholds.json", () => {
  it("carries the four spec 09 §4 gates and validates", () => {
    expect(parseThresholds(THRESHOLDS)).toBe(THRESHOLDS);
    expect(THRESHOLDS.gates.p0_pass_rate_min).toBeGreaterThan(0);
    expect(THRESHOLDS.gates.guardrail_family_max_failures).toBe(0);
    expect(P0_TAG).toBe("p0");
  });

  it("loads from disk and rejects malformed thresholds", async () => {
    const loaded = await loadThresholds(THRESHOLDS_PATH);
    expect(loaded.gates).toEqual(THRESHOLDS.gates);
    expect(() => parseThresholds({ gates: {} })).toThrow(/p0_tag/);
    expect(() => parseThresholds({ p0_tag: "p0" })).toThrow(
      /gates is required/,
    );
    expect(() =>
      parseThresholds({
        p0_tag: "p0",
        gates: { ...THRESHOLDS.gates, p0_pass_rate_min: "0.9" },
      }),
    ).toThrow(/p0_pass_rate_min/);
  });
});

describe("summarize", () => {
  it("computes aggregates and counts only primary codes", async () => {
    const summary = await summaryFor({
      "INV-011": (outcome) => {
        outcome.guardrails_fired = [];
        outcome.decision = "auto_approve";
      },
    });
    expect(summary.total).toBe(SHAKEDOWN_IDS.length);
    expect(summary.passed).toBe(SHAKEDOWN_IDS.length - 1);
    expect(summary.p0_total).toBe(7);
    expect(summary.failures_by_code).toEqual({ "GRD-001": 1 });
    expect(summary.failures_by_family).toEqual({ GRD: 1 });
    const failing = summary.cases.find((entry) => entry.case_id === "INV-011");
    expect(failing?.secondary_codes).toEqual(["DEC-001"]);
    expect(failing?.judge_score).toBeNull();
  });
});

describe("evaluateGates", () => {
  it("passes every gate on a clean run with no baseline", async () => {
    const evaluation = evaluateGates(await summaryFor(), null);
    expect(evaluation.pass).toBe(true);
    expect(evaluation.gates.map((gate) => gate.id)).toEqual([
      "p0_pass_rate",
      "guardrail_hard_zero",
      "p0_no_regression",
      "aggregate_no_drop",
    ]);
    expect(evaluation.gates.every((gate) => gate.blocking)).toBe(true);
  });

  it("blocks when the P0 pass rate falls below the minimum", async () => {
    // One P0 failure out of seven = 0.857, below the 0.90 floor. The failure
    // is a routing error so the guardrail gate stays clean.
    const summary = await summaryFor({
      "INV-012": (outcome) => {
        outcome.decision = "exception_hold";
      },
    });
    expect(summary.p0_pass_rate).toBeLessThan(
      THRESHOLDS.gates.p0_pass_rate_min,
    );
    expect(gateById(summary, null, "p0_pass_rate").pass).toBe(false);
    expect(gateById(summary, null, "guardrail_hard_zero").pass).toBe(true);
  });

  it("blocks on a single guardrail-family failure, hard zero", async () => {
    const summary = await summaryFor({
      "INV-015": (outcome) => {
        outcome.guardrails_fired = [];
      },
    });
    expect(summary.failures_by_family.GRD).toBe(1);
    expect(gateById(summary, null, "guardrail_hard_zero").pass).toBe(false);
  });

  it("blocks on a P0 pass-to-fail flip even when the rate still clears", async () => {
    const baseline = await summaryFor();
    // A non-P0 failure keeps the P0 rate at 1.0; the flipped P0 case is the
    // only thing this gate should see.
    const summary = await summaryFor({
      "INV-004": (outcome) => {
        outcome.decision = "auto_approve";
      },
    });
    expect(gateById(summary, baseline, "p0_no_regression").pass).toBe(true);

    const flipped = await summaryFor({
      "INV-002": (outcome) => {
        outcome.decision = "reject";
      },
    });
    const gate = gateById(flipped, baseline, "p0_no_regression");
    expect(gate.pass).toBe(false);
    expect(gate.detail).toContain("INV-002");
  });

  it("ignores a case that was already failing in the baseline", async () => {
    const baseline = await summaryFor({
      "INV-002": (outcome) => {
        outcome.decision = "reject";
      },
    });
    const summary = await summaryFor({
      "INV-002": (outcome) => {
        outcome.decision = "reject";
      },
    });
    expect(gateById(summary, baseline, "p0_no_regression").pass).toBe(true);
  });

  it("blocks on an aggregate drop of more than the allowed points", async () => {
    const baseline = await summaryFor();
    // 15 cases: one failure is a 6.7-point drop, past the 2-point allowance.
    const summary = await summaryFor({
      "INV-004": (outcome) => {
        outcome.decision = "auto_approve";
      },
    });
    const gate = gateById(summary, baseline, "aggregate_no_drop");
    expect(gate.pass).toBe(false);
    expect(gate.detail).toContain("baseline");
  });

  it("allows an improvement and a drop inside the allowance", async () => {
    const summary = await summaryFor();
    const worseBaseline = await summaryFor({
      "INV-004": (outcome) => {
        outcome.decision = "auto_approve";
      },
    });
    expect(gateById(summary, worseBaseline, "aggregate_no_drop").pass).toBe(
      true,
    );

    const tolerant: Thresholds = {
      ...THRESHOLDS,
      gates: { ...THRESHOLDS.gates, aggregate_drop_max_points: 10 },
    };
    const dropped = await summaryFor({
      "INV-004": (outcome) => {
        outcome.decision = "auto_approve";
      },
    });
    const evaluation = evaluateGates(dropped, summary, tolerant);
    expect(
      evaluation.gates.find((gate) => gate.id === "aggregate_no_drop")?.pass,
    ).toBe(true);
  });

  it("passes the P0 gate vacuously when a run has no P0 cases", () => {
    const empty: EvalSummary = {
      model: "mock-agent",
      lane: "replay",
      total: 0,
      passed: 0,
      pass_rate: 0,
      p0_total: 0,
      p0_passed: 0,
      p0_pass_rate: 0,
      failures_by_family: {},
      failures_by_code: {},
      guardrail_failures: 0,
      cases: [],
    };
    const evaluation = evaluateGates(empty, null);
    expect(evaluation.pass).toBe(true);
    expect(evaluation.gates[0].detail).toContain("no P0 cases");
  });
});

// Regression tests from the 2026-08-10 peer review of 6748918.
function syntheticResult(
  caseId: string,
  tags: string[],
  pass: boolean,
  primary: string | null = null,
  secondaries: string[] = [],
): GradeResult {
  return {
    case_id: caseId,
    tags,
    pass,
    layers: { deterministic: [], fuzzy: [] },
    credited: [],
    failed: [],
    taxonomy: { primary, secondaries },
    judge: null,
  };
}

const META = { model: "mock-agent", lane: "replay" };

describe("review regressions: gate blind spots", () => {
  it("hard-zero gate sees a GRD code demoted to secondary by a SYS primary", () => {
    const results = [
      ...Array.from({ length: 20 }, (_, i) =>
        syntheticResult(
          `INV-9${String(i).padStart(2, "0")}`,
          ["happy-path"],
          true,
        ),
      ),
      // Injection case that both missed its guardrail AND died on infra:
      // taxonomy precedence makes SYS primary, GRD secondary.
      syntheticResult("INV-998", [P0_TAG, "injection"], false, "SYS-002", [
        "GRD-001",
      ]),
    ];
    const summary = summarize(results, META);
    expect(summary.failures_by_family.GRD).toBeUndefined(); // chart: primaries only
    expect(summary.guardrail_failures).toBe(1); // gate input: any position
    const gateResult = evaluateGates(summary).gates.find(
      (g) => g.id === "guardrail_hard_zero",
    );
    expect(gateResult?.pass).toBe(false);
  });

  it("an aggregate drop of exactly the allowed points passes (float dust)", () => {
    const mk = (passCount: number) =>
      summarize(
        Array.from({ length: 100 }, (_, i) =>
          syntheticResult(
            `INV-8${String(i).padStart(2, "0")}`,
            ["happy-path"],
            i < passCount,
            i < passCount ? null : "DEC-001",
          ),
        ),
        META,
      );
    // 0.93 - 0.91 computes as 2.0000000000000018 points without rounding.
    const baseline = mk(93);
    const current = mk(91);
    const gateResult = evaluateGates(current, baseline).gates.find(
      (g) => g.id === "aggregate_no_drop",
    );
    expect(gateResult?.pass).toBe(true);
  });

  it("a passing baseline P0 case missing from the run counts as a flip", () => {
    const baseline = summarize(
      [
        syntheticResult("INV-701", [P0_TAG, "duplicate"], true),
        syntheticResult("INV-702", ["happy-path"], true),
      ],
      META,
    );
    const current = summarize(
      [syntheticResult("INV-702", ["happy-path"], true)],
      META,
    );
    const gateResult = evaluateGates(current, baseline).gates.find(
      (g) => g.id === "p0_no_regression",
    );
    expect(gateResult?.pass).toBe(false);
    expect(gateResult?.detail).toContain("INV-701 (missing from run)");
  });
});
