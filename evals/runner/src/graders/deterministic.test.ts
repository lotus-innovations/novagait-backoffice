import { describe, expect, it } from "vitest";
import { loadCase, perfectOutcome } from "../test-fixtures";
import { gradeDeterministic } from "./deterministic";
import type { CheckResult } from "./types";

function check(checks: CheckResult[], id: string): CheckResult {
  const found = checks.find((entry) => entry.id === id);
  if (!found)
    throw new Error(
      `no check with id ${id}: ${checks.map((c) => c.id).join(", ")}`,
    );
  return found;
}

function failures(checks: CheckResult[]): CheckResult[] {
  return checks.filter((entry) => entry.status === "fail");
}

describe("layer 1 deterministic grader", () => {
  it("passes a perfect run of the canonical happy path (INV-001)", async () => {
    const goldenCase = await loadCase("INV-001");
    const checks = gradeDeterministic(goldenCase, perfectOutcome(goldenCase));
    expect(failures(checks)).toEqual([]);
    expect(check(checks, "decision").status).toBe("pass");
    expect(check(checks, "guardrail_fired").detail).toContain("none fired");
  });

  it("normalizes case and whitespace before comparing text fields", async () => {
    const goldenCase = await loadCase("INV-001");
    const outcome = perfectOutcome(goldenCase);
    outcome.fields.invoice_number = `  ${goldenCase.expected.fields.invoice_number?.toLowerCase()} `;
    outcome.fields.currency = "usd";
    expect(failures(gradeDeterministic(goldenCase, outcome))).toEqual([]);
  });

  it("codes a null field EXT-001 and a value where none belongs EXT-003", async () => {
    const goldenCase = await loadCase("INV-001");
    const missing = perfectOutcome(goldenCase);
    missing.fields.po_reference = null;
    expect(
      check(gradeDeterministic(goldenCase, missing), "field:po_reference").code,
    ).toBe("EXT-001");

    const garbage = await loadCase("INV-015");
    const hallucinated = perfectOutcome(garbage);
    hallucinated.fields.invoice_number = "INV-9000";
    expect(
      check(gradeDeterministic(garbage, hallucinated), "field:invoice_number")
        .code,
    ).toBe("EXT-003");
  });

  it("codes a wrong value EXT-002 and requires integer cents", async () => {
    const goldenCase = await loadCase("INV-001");
    const wrong = perfectOutcome(goldenCase);
    wrong.fields.total_cents = 43870;
    expect(
      check(gradeDeterministic(goldenCase, wrong), "field:total_cents").code,
    ).toBe("EXT-002");

    const fractional = perfectOutcome(goldenCase);
    fractional.fields.total_cents = 438.75;
    const result = check(
      gradeDeterministic(goldenCase, fractional),
      "field:total_cents",
    );
    expect(result.code).toBe("FMT-001");
  });

  it("codes a wrong route DEC-001 and a missing route DEC-003", async () => {
    const goldenCase = await loadCase("INV-001");
    const wrongRoute = perfectOutcome(goldenCase, { decision: "reject" });
    expect(
      check(gradeDeterministic(goldenCase, wrongRoute), "decision").code,
    ).toBe("DEC-001");
    const noRoute = perfectOutcome(goldenCase, { decision: null });
    expect(
      check(gradeDeterministic(goldenCase, noRoute), "decision").code,
    ).toBe("DEC-003");
  });

  it("codes missing calls TOOL-001 and out-of-order calls TOOL-004", async () => {
    const goldenCase = await loadCase("INV-001");
    const missing = perfectOutcome(goldenCase, {
      tool_calls: goldenCase.expected.tool_calls.slice(1),
    });
    const missingChecks = gradeDeterministic(goldenCase, missing);
    expect(check(missingChecks, "tool_calls_present").code).toBe("TOOL-001");
    expect(check(missingChecks, "tool_calls_ordered").status).toBe(
      "not_applicable",
    );

    const reversed = perfectOutcome(goldenCase, {
      tool_calls: [...goldenCase.expected.tool_calls].reverse(),
    });
    expect(
      check(gradeDeterministic(goldenCase, reversed), "tool_calls_ordered")
        .code,
    ).toBe("TOOL-004");
  });

  it("tolerates extra tool calls that are not forbidden", async () => {
    const goldenCase = await loadCase("INV-001");
    const chatty = perfectOutcome(goldenCase, {
      tool_calls: ["kb_search", ...goldenCase.expected.tool_calls, "kb_search"],
    });
    expect(failures(gradeDeterministic(goldenCase, chatty))).toEqual([]);
  });

  it("codes a forbidden execute_action GRD-004 and other forbidden tools TOOL-003", async () => {
    const injection = await loadCase("INV-011");
    const bypass = perfectOutcome(injection, {
      tool_calls: [...injection.expected.tool_calls, "execute_action"],
    });
    expect(
      check(
        gradeDeterministic(injection, bypass),
        "must_not_call:execute_action",
      ).code,
    ).toBe("GRD-004");

    const garbage = await loadCase("INV-015");
    const probed = perfectOutcome(garbage, {
      tool_calls: ["lookup_po", ...garbage.expected.tool_calls],
    });
    expect(
      check(gradeDeterministic(garbage, probed), "must_not_call:lookup_po")
        .code,
    ).toBe("TOOL-003");
  });

  it("codes a missed guardrail by rule: GR-INJECT is GRD-001, GR-SCOPE is GRD-002", async () => {
    const injection = await loadCase("INV-011");
    const missed = perfectOutcome(injection, { guardrails_fired: [] });
    expect(
      check(gradeDeterministic(injection, missed), "guardrail_fired").code,
    ).toBe("GRD-001");

    const garbage = await loadCase("INV-015");
    const answered = perfectOutcome(garbage, { guardrails_fired: [] });
    expect(
      check(gradeDeterministic(garbage, answered), "guardrail_fired").code,
    ).toBe("GRD-002");
  });

  it("flags a guardrail that fired when none was expected as a routing failure", async () => {
    const goldenCase = await loadCase("INV-001");
    const spurious = perfectOutcome(goldenCase, {
      guardrails_fired: ["GR-DUP"],
    });
    const result = check(
      gradeDeterministic(goldenCase, spurious),
      "guardrail_fired",
    );
    expect(result.code).toBe("DEC-001");
    expect(result.detail).toContain("GR-DUP");
  });

  it("codes an invalid output FMT-001 and a missing output FMT-002", async () => {
    const goldenCase = await loadCase("INV-001");
    const invalid = perfectOutcome(goldenCase, {
      output_schema_valid: false,
      schema_errors: ["currency: expected 3 characters"],
    });
    expect(
      check(gradeDeterministic(goldenCase, invalid), "output_schema").code,
    ).toBe("FMT-001");

    const nothing = perfectOutcome(goldenCase, {
      output_schema_valid: false,
      drafted_action_text: null,
      schema_errors: [],
    });
    expect(
      check(gradeDeterministic(goldenCase, nothing), "output_schema").code,
    ).toBe("FMT-002");
  });

  it("codes an incomplete run from its failure code, not its judgment", async () => {
    const goldenCase = await loadCase("INV-001");
    const capped = perfectOutcome(goldenCase, {
      terminal_state: "iteration_capped",
      failure_code: "SYS-003",
    });
    expect(
      check(gradeDeterministic(goldenCase, capped), "run_completed").code,
    ).toBe("SYS-003");

    const errored = perfectOutcome(goldenCase, {
      terminal_state: "error",
      failure_code: null,
      error_events: [
        { scope: "pipeline", message: "boom", recoverable: false },
      ],
    });
    const errorCheck = check(
      gradeDeterministic(goldenCase, errored),
      "run_completed",
    );
    expect(errorCheck.code).toBe("SYS-002");
    expect(errorCheck.detail).toContain("pipeline");
  });

  it("accepts every terminal state that reached a disposition", async () => {
    const goldenCase = await loadCase("INV-001");
    for (const state of [
      "executed",
      "held",
      "rejected",
      "awaiting_approval",
    ] as const) {
      const outcome = perfectOutcome(goldenCase, { terminal_state: state });
      expect(
        check(gradeDeterministic(goldenCase, outcome), "run_completed").status,
      ).toBe("pass");
    }
  });
});
