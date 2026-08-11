import { describe, expect, it } from "vitest";
import { grade, gradeWithJudge } from "./grade";
import type { JudgeClient } from "./graders/judge";
import { SHAKEDOWN_IDS, loadCase, perfectOutcome } from "./test-fixtures";

const VENDORS = [{ id: "V-002", canonical_name: "Meridex Equipment Leasing" }];

describe("grade orchestrator", () => {
  it("passes a perfect run of every shakedown case with no taxonomy code", async () => {
    for (const id of SHAKEDOWN_IDS) {
      const goldenCase = await loadCase(id);
      const result = grade(goldenCase, perfectOutcome(goldenCase));
      expect(
        result.pass,
        `${id}: ${result.failed.map((c) => c.detail).join("; ")}`,
      ).toBe(true);
      expect(result.taxonomy.primary).toBeNull();
      expect(result.taxonomy.secondaries).toEqual([]);
    }
  });

  it("lets a layer-2 credit rescue a layer-1 miss", async () => {
    const goldenCase = await loadCase("INV-011");
    const outcome = perfectOutcome(goldenCase);
    outcome.fields.vendor_id = null;
    outcome.fields.vendor_name_raw = "Meridex Equip. Leasing";

    const uncredited = grade(goldenCase, outcome);
    expect(uncredited.pass).toBe(false);
    expect(uncredited.taxonomy.primary).toBe("EXT-001");

    const credited = grade(goldenCase, outcome, { vendors: VENDORS });
    expect(credited.pass).toBe(true);
    expect(credited.credited).toEqual(["field:vendor_id"]);
    expect(credited.taxonomy.primary).toBeNull();
  });

  it("fails on a layer-2 check that has no layer-1 counterpart", async () => {
    const goldenCase = await loadCase("INV-001");
    const outcome = perfectOutcome(goldenCase);
    outcome.fields.invoice_date = "the third of August";

    const result = grade(goldenCase, outcome);
    expect(result.pass).toBe(false);
    expect(result.taxonomy.primary).toBe("EXT-002");
  });

  it("assigns exactly one primary code by family precedence", async () => {
    const goldenCase = await loadCase("INV-011");
    // One outcome that fails in every family at once, then repaired one
    // family at a time: the primary must walk the declared precedence
    // SYS -> GRD -> FMT -> TOOL -> EXT -> DEC.
    const broken = perfectOutcome(goldenCase, {
      terminal_state: "error",
      failure_code: null,
      guardrails_fired: [],
      output_schema_valid: false,
      schema_errors: ["currency: expected 3 characters"],
      tool_calls: [],
      decision: "auto_approve",
    });
    broken.fields.invoice_number = "WRONG-1";

    const expectations: [Partial<typeof broken>, string][] = [
      [{}, "SYS-002"],
      [{ terminal_state: "held" }, "GRD-001"],
      [{ guardrails_fired: ["GR-INJECT"] }, "FMT-001"],
      [{ output_schema_valid: true, schema_errors: [] }, "TOOL-001"],
      [{ tool_calls: [...goldenCase.expected.tool_calls] }, "EXT-002"],
    ];

    let outcome = broken;
    for (const [repair, primary] of expectations) {
      outcome = { ...outcome, ...repair };
      expect(grade(goldenCase, outcome).taxonomy.primary).toBe(primary);
    }

    outcome = {
      ...outcome,
      fields: {
        ...outcome.fields,
        invoice_number: goldenCase.expected.fields.invoice_number,
      },
    };
    const decisionOnly = grade(goldenCase, outcome);
    expect(decisionOnly.taxonomy.primary).toBe("DEC-001");
    expect(decisionOnly.taxonomy.secondaries).toEqual([]);
  });

  it("orders secondaries by precedence and never repeats the primary", async () => {
    const goldenCase = await loadCase("INV-011");
    const outcome = perfectOutcome(goldenCase, {
      guardrails_fired: [],
      decision: "auto_approve",
    });
    outcome.fields.total_cents = 1;

    const result = grade(goldenCase, outcome);
    expect(result.taxonomy.primary).toBe("GRD-001");
    expect(result.taxonomy.secondaries).toEqual(["EXT-002", "DEC-001"]);
  });

  it("keeps every check on the result, grouped by layer", async () => {
    const goldenCase = await loadCase("INV-001");
    const result = grade(goldenCase, perfectOutcome(goldenCase));
    expect(
      result.layers.deterministic.every((check) => check.layer === 1),
    ).toBe(true);
    expect(result.layers.fuzzy.every((check) => check.layer === 2)).toBe(true);
    expect(result.layers.deterministic.length).toBeGreaterThan(8);
    expect(result.judge).toBeNull();
  });

  it("reports the judge alongside the verdict without changing pass/fail", async () => {
    const goldenCase = await loadCase("INV-001");
    const client: JudgeClient = {
      evaluate: async () => ({
        score: 0.1,
        verdict: "fail",
        rationale: "Terse.",
        evidence_quotes: [],
      }),
    };

    const passing = await gradeWithJudge(
      goldenCase,
      perfectOutcome(goldenCase),
      {
        judge: { client },
      },
    );
    expect(passing.pass).toBe(true);
    expect(passing.judge?.verdict?.verdict).toBe("fail");

    const failing = await gradeWithJudge(
      goldenCase,
      perfectOutcome(goldenCase, { decision: "reject" }),
      { judge: { client } },
    );
    expect(failing.pass).toBe(false);
    expect(failing.taxonomy.primary).toBe("DEC-001");
  });
});
