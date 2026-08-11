import {
  TRACE_SCHEMA_VERSION,
  type TraceEvent,
  type TraceEventInput,
} from "@novagait/agent";
import { describe, expect, it } from "vitest";
import { fromTraceEvents } from "./outcome";

const RUN_ID = "01JRUNADAPTER0000000000000";

// Monotonic across the file: only the relative order inside one event
// array matters to the adapter.
let seq = 0;
function event(payload: TraceEventInput): TraceEvent {
  return {
    run_id: RUN_ID,
    ts: "2026-08-10T12:00:00-0700",
    seq: seq++,
    trace_schema_version: TRACE_SCHEMA_VERSION,
    ...payload,
  } as TraceEvent;
}

const EXTRACTION = {
  vendor_name_raw: "Corvida Billing Services LLC",
  vendor_id: "V-001",
  invoice_number: "CB-2026-0803",
  invoice_date: "2026-08-03",
  due_date: "2026-09-02",
  currency: "USD",
  subtotal_cents: 43875,
  tax_cents: 0,
  total_cents: 43875,
  po_reference: "PO-2201",
  line_items: [
    {
      description: "Monthly billing service",
      qty: 1,
      unit_price_cents: 43875,
      amount_cents: 43875,
    },
  ],
  remit_to: null,
  source_spans: { total_cents: "Total due $438.75" },
};

function toolCall(
  name: string,
  args: Record<string, unknown> = {},
): TraceEvent {
  return event({
    type: "tool.call",
    node_id: `agent.iter[0].tool[${name}]`,
    name,
    args: args as never,
    result_summary: "ok",
    duration_ms: 4,
    attempt: 1,
  });
}

function startEvent(): TraceEvent {
  return event({
    type: "run.start",
    node_id: "run",
    mode: "assisted",
    input_ref: "inbox/2026-08-03-corvida-monthly.md",
    prompt_version: "1.0.0",
    tools_version: "1.0.0",
    model: "claude-haiku-4-5",
    sdk_version: "0.0.0",
  });
}

function endEvent(
  overrides: Partial<Extract<TraceEvent, { type: "run.end" }>> = {},
): TraceEvent {
  const payload = {
    type: "run.end",
    node_id: "run",
    outcome: "executed",
    total_cost_micro_usd: 900,
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    iteration_count: 3,
    failure_code: null,
    ...overrides,
  };
  return event(payload as TraceEventInput);
}

describe("fromTraceEvents", () => {
  it("projects a full trace onto a graded outcome", () => {
    const events = [
      startEvent(),
      event({
        type: "guardrail.check",
        node_id: "guardrail[GR-SCOPE]",
        rule_id: "GR-SCOPE",
        input_digest: "abc",
        verdict: "pass",
        action_taken: "none",
      }),
      event({
        type: "guardrail.check",
        node_id: "guardrail[GR-INJECT]",
        rule_id: "GR-INJECT",
        input_digest: "abc",
        verdict: "block",
        action_taken: "force_exception_hold",
      }),
      toolCall("lookup_vendor", { name_raw: "Corvida Billing Services" }),
      toolCall("draft_action", {
        route: "exception_hold",
        summary: "Held for review: remit-to redirect detected.",
        extraction: EXTRACTION,
      }),
      endEvent({ outcome: "held" }),
    ];

    const outcome = fromTraceEvents(events, { case_id: "INV-011" });
    expect(outcome.run_id).toBe(RUN_ID);
    expect(outcome.model).toBe("claude-haiku-4-5");
    expect(outcome.mode).toBe("assisted");
    expect(outcome.tool_calls).toEqual(["lookup_vendor", "draft_action"]);
    // Only blocking checks count as "fired".
    expect(outcome.guardrails_fired).toEqual(["GR-INJECT"]);
    expect(outcome.decision).toBe("exception_hold");
    expect(outcome.drafted_action_text).toContain("remit-to redirect");
    expect(outcome.fields.vendor_id).toBe("V-001");
    expect(outcome.fields.total_cents).toBe(43875);
    expect(outcome.output_schema_valid).toBe(true);
    expect(outcome.terminal_state).toBe("held");
  });

  it("sorts by seq, so trace order on disk does not matter", () => {
    const start = startEvent();
    const call = toolCall("draft_action", {
      route: "auto_approve",
      summary: "ok",
    });
    const end = endEvent();
    const outcome = fromTraceEvents([end, call, start], { case_id: "INV-001" });
    expect(outcome.model).toBe("claude-haiku-4-5");
    expect(outcome.terminal_state).toBe("executed");
  });

  it("takes extraction fields from the caller when the trace does not carry them", () => {
    // The mock lane traces only { route, summary }; the extraction lives in
    // the run store.
    const events = [
      startEvent(),
      toolCall("draft_action", { route: "auto_approve", summary: "Approved." }),
      endEvent(),
    ];
    const outcome = fromTraceEvents(events, {
      case_id: "INV-001",
      fields: { vendor_id: "V-001", total_cents: 43875 },
    });
    expect(outcome.fields.vendor_id).toBe("V-001");
    expect(outcome.fields.invoice_number).toBeNull();
    expect(outcome.output_schema_valid).toBe(true);
    expect(outcome.schema_errors).toEqual([]);
  });

  it("reports an invalid extraction as a schema failure with its issues", () => {
    const events = [
      startEvent(),
      toolCall("draft_action", {
        route: "auto_approve",
        summary: "Approved.",
        extraction: { ...EXTRACTION, currency: "DOLLARS", total_cents: 1.5 },
      }),
      endEvent(),
    ];
    const outcome = fromTraceEvents(events, { case_id: "INV-001" });
    expect(outcome.output_schema_valid).toBe(false);
    expect(outcome.schema_errors.join(" ")).toContain("currency");
  });

  it("treats a run that never drafted as having no structured output", () => {
    const outcome = fromTraceEvents(
      [
        startEvent(),
        toolCall("lookup_vendor"),
        endEvent({ outcome: "iteration_capped", failure_code: "SYS-003" }),
      ],
      { case_id: "INV-001" },
    );
    expect(outcome.decision).toBeNull();
    expect(outcome.drafted_action_text).toBeNull();
    expect(outcome.output_schema_valid).toBe(false);
    expect(outcome.schema_errors[0]).toContain("no draft_action");
    expect(outcome.failure_code).toBe("SYS-003");
  });

  it("carries error events and defaults a truncated trace to an error state", () => {
    const events = [
      startEvent(),
      event({
        type: "error",
        node_id: "error[pipeline]",
        scope: "pipeline",
        message: "backend write failed",
        recoverable: false,
      }),
    ];
    const outcome = fromTraceEvents(events, { case_id: "INV-001" });
    expect(outcome.error_events).toEqual([
      {
        scope: "pipeline",
        message: "backend write failed",
        recoverable: false,
      },
    ]);
    expect(outcome.terminal_state).toBe("error");
  });
});
