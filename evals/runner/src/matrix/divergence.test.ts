// Regression cover for the divergence column.
//
// INCIDENT 2026-08-12: the published matrix reported a model-vs-policy
// divergence of 0 on all three lanes while those same lanes failed GRD-004 on
// 29 cases, i.e. the model demonstrably asked for things policy did not
// dispose. The join read the proposal from a map that is only populated by
// RUNNING a case, and all three lanes were resumed from checkpoints, so it
// joined against nothing and rendered the empty result as zero. A column that
// cannot tell must say so.

import { describe, expect, test } from "vitest";
import type { RunOutcome } from "../outcome";
import type { CaseRunRecord } from "./batch";
import { laneDivergence } from "./results";

const LANE = "claude-haiku-4-5:uncached";

function record(
  caseId: string,
  modelRoute: string | null,
  overrides: Partial<CaseRunRecord> = {},
): CaseRunRecord {
  return {
    case_id: caseId,
    run_id: `RUN-${caseId}`,
    lane: LANE,
    model: "claude-haiku-4-5",
    mode: "uncached",
    iterations: 3,
    short_circuit: false,
    stop_reason: "end_turn",
    transport_error: null,
    iteration_capped: false,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    cost_usd: 0,
    model_route: modelRoute,
    ...overrides,
  };
}

function outcome(caseId: string, decision: string): RunOutcome {
  return {
    case_id: caseId,
    run_id: `RUN-${caseId}`,
    model: "claude-haiku-4-5",
    mode: "autonomous",
    fields: {},
    decision: decision as RunOutcome["decision"],
    tool_calls: [],
    guardrails_fired: [],
    drafted_action_text: null,
    output_schema_valid: true,
    schema_errors: [],
    terminal_state: "executed",
    failure_code: null,
    error_events: [],
  } as unknown as RunOutcome;
}

describe("laneDivergence", () => {
  test("counts cases where the model proposed a route policy did not dispose", () => {
    const records = [
      record("INV-001", "auto_approve"),
      record("INV-002", "auto_approve"),
      record("INV-003", "exception_hold"),
    ];
    const outcomes = [
      outcome("INV-001", "auto_approve"),
      outcome("INV-002", "exception_hold"),
      outcome("INV-003", "exception_hold"),
    ];
    expect(laneDivergence({ lane: LANE, records, outcomes })).toBe(1);
  });

  test("a checkpoint written before route persistence reports null, not zero", () => {
    // This is the exact shape of the three published lanes: real records,
    // real outcomes, no captured proposal on any of them.
    const records = [record("INV-001", null), record("INV-002", null)];
    const outcomes = [
      outcome("INV-001", "auto_approve"),
      outcome("INV-002", "exception_hold"),
    ];
    expect(laneDivergence({ lane: LANE, records, outcomes })).toBeNull();
  });

  test("falls back to in-process proposals for records that predate the field", () => {
    const records = [record("INV-001", null), record("INV-002", null)];
    const outcomes = [
      outcome("INV-001", "auto_approve"),
      outcome("INV-002", "auto_approve"),
    ];
    const proposals = new Map([
      ["RUN-INV-001", "auto_approve"],
      ["RUN-INV-002", "route_for_approval"],
    ]);
    expect(
      laneDivergence({
        lane: LANE,
        records,
        outcomes,
        fallback: (runId) => proposals.get(runId) ?? null,
      }),
    ).toBe(1);
  });

  test("ignores records belonging to other lanes", () => {
    const records = [
      record("INV-001", "auto_approve"),
      record("INV-002", "auto_approve", { lane: "claude-opus-5:uncached" }),
    ];
    const outcomes = [outcome("INV-001", "auto_approve")];
    expect(laneDivergence({ lane: LANE, records, outcomes })).toBe(0);
  });
});
