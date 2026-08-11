// Test-only helpers. Golden cases are loaded ONE FILE AT A TIME by id: the
// dataset is being extended concurrently (INV-016+), and a grader test must
// not depend on how many cases exist today.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { validateGoldenCase, type Decision, type GoldenCase } from "./golden";
import { EMPTY_FIELDS, type RunOutcome } from "./outcome";

const GOLDEN_DIR = fileURLToPath(new URL("../../golden", import.meta.url));

export const SHAKEDOWN_IDS = Array.from(
  { length: 15 },
  (_, index) => `INV-${String(index + 1).padStart(3, "0")}`,
);

export async function loadCase(id: string): Promise<GoldenCase> {
  const parsed = JSON.parse(
    await readFile(join(GOLDEN_DIR, `${id}.json`), "utf8"),
  );
  const validation = validateGoldenCase(parsed);
  if (!validation.valid) {
    throw new Error(`${id}: ${validation.errors.join("; ")}`);
  }
  return parsed as GoldenCase;
}

const TERMINAL_BY_DECISION: Record<Decision, RunOutcome["terminal_state"]> = {
  auto_approve: "executed",
  route_for_approval: "awaiting_approval",
  exception_hold: "held",
  reject: "rejected",
};

// The run a perfect agent would produce for this case. Tests mutate one
// field of it at a time, so each assertion isolates exactly one failure.
export function perfectOutcome(
  goldenCase: GoldenCase,
  overrides: Partial<RunOutcome> = {},
): RunOutcome {
  const expected = goldenCase.expected;
  return {
    case_id: goldenCase.id,
    run_id: `RUN-${goldenCase.id}`,
    model: "mock-agent",
    mode: "assisted",
    fields: {
      ...EMPTY_FIELDS,
      ...expected.fields,
      vendor_name_raw:
        expected.fields.vendor_id === null ? null : "Fixture Vendor LLC",
      invoice_date: "2026-08-03",
    },
    decision: expected.decision,
    tool_calls: [...expected.tool_calls],
    guardrails_fired: expected.guardrail === null ? [] : [expected.guardrail],
    drafted_action_text: `Drafted ${expected.decision} for ${goldenCase.id}.`,
    output_schema_valid: true,
    schema_errors: [],
    terminal_state: TERMINAL_BY_DECISION[expected.decision],
    failure_code: null,
    error_events: [],
    ...overrides,
  };
}
