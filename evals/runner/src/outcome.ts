// RunOutcome: the graded view of one agent run (spec 09 §2). Everything the
// three grader layers compare against lives here and nowhere else, so a
// live run, a replayed cassette, and a hand-built test fixture are graded by
// identical code. Field names track the frozen extraction schema and the
// trace event schema (packages/agent) on purpose: the adapter below is a
// projection, not a translation.

import {
  extractionSchema,
  type Decision,
  type RunMode,
  type RunOutcome as TerminalState,
  type TraceEvent,
} from "@novagait/agent";

export interface RunOutcomeFields {
  vendor_id: string | null;
  vendor_name_raw: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_cents: number | null;
  currency: string | null;
  po_reference: string | null;
}

export interface RunErrorEvent {
  scope: string;
  message: string;
  recoverable: boolean;
}

export interface RunOutcome {
  case_id: string;
  run_id: string;
  model: string;
  mode: RunMode | null;
  fields: RunOutcomeFields;
  // null means the run ended without recording a route (DEC-003).
  decision: Decision | null;
  // Tool names in call order, duplicates preserved: order assertions and
  // must_not_call both read this one list.
  tool_calls: string[];
  // Rule ids of guardrails that BLOCKED (a passing check is not "fired").
  guardrails_fired: string[];
  drafted_action_text: string | null;
  output_schema_valid: boolean;
  schema_errors: string[];
  terminal_state: TerminalState;
  failure_code: string | null;
  error_events: RunErrorEvent[];
}

export const EMPTY_FIELDS: RunOutcomeFields = {
  vendor_id: null,
  vendor_name_raw: null,
  invoice_number: null,
  invoice_date: null,
  due_date: null,
  total_cents: null,
  currency: null,
  po_reference: null,
};

// The trace carries the run's behaviour (tools, guardrails, route, terminal
// state) but not always the full extraction: the mock lane traces only
// { route, summary } on draft_action and keeps the extraction in the run
// store (packages/pipeline). Callers supply what the trace cannot.
export interface TraceAdapterExtras {
  case_id: string;
  fields?: Partial<RunOutcomeFields>;
  // Override only when the extraction is unavailable from both the trace and
  // `fields`; otherwise validity is computed from the extraction itself.
  output_schema_valid?: boolean;
}

type EventOfType<T extends TraceEvent["type"]> = Extract<
  TraceEvent,
  { type: T }
>;

function eventsOfType<T extends TraceEvent["type"]>(
  events: TraceEvent[],
  type: T,
): EventOfType<T>[] {
  return events.filter((event): event is EventOfType<T> => event.type === type);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function fromTraceEvents(
  events: TraceEvent[],
  extras: TraceAdapterExtras,
): RunOutcome {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const start = eventsOfType(ordered, "run.start")[0];
  const end = eventsOfType(ordered, "run.end")[0];
  const toolCalls = eventsOfType(ordered, "tool.call");
  const draft = toolCalls
    .filter((event) => event.name === "draft_action")
    .pop();

  const rawExtraction = draft?.args.extraction;
  const parsed =
    rawExtraction === undefined
      ? null
      : extractionSchema.safeParse(rawExtraction);

  const extracted: Partial<RunOutcomeFields> = parsed?.success
    ? {
        vendor_id: parsed.data.vendor_id,
        vendor_name_raw: parsed.data.vendor_name_raw,
        invoice_number: parsed.data.invoice_number,
        invoice_date: parsed.data.invoice_date,
        due_date: parsed.data.due_date,
        total_cents: parsed.data.total_cents,
        currency: parsed.data.currency,
        po_reference: parsed.data.po_reference,
      }
    : {};

  const schemaErrors =
    parsed && !parsed.success
      ? parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        )
      : [];

  // No extraction anywhere: a run that never drafted produced no structured
  // output at all (FMT-002), which is a different failure from an invalid
  // one. Callers with the extraction in hand override via extras.
  const outputSchemaValid =
    parsed !== null
      ? parsed.success
      : (extras.output_schema_valid ?? draft !== undefined);

  return {
    case_id: extras.case_id,
    run_id: start?.run_id ?? end?.run_id ?? ordered[0]?.run_id ?? "",
    model: start?.model ?? "",
    mode: start?.mode ?? ordered.find((event) => event.mode)?.mode ?? null,
    fields: { ...EMPTY_FIELDS, ...extracted, ...extras.fields },
    decision: (asString(draft?.args.route) as Decision | null) ?? null,
    tool_calls: toolCalls.map((event) => event.name),
    guardrails_fired: eventsOfType(ordered, "guardrail.check")
      .filter((event) => event.verdict === "block")
      .map((event) => event.rule_id),
    drafted_action_text: asString(draft?.args.summary),
    output_schema_valid: outputSchemaValid,
    schema_errors:
      parsed === null && !outputSchemaValid
        ? ["no draft_action recorded: no structured output to validate"]
        : schemaErrors,
    terminal_state: end?.outcome ?? "error",
    failure_code: end?.failure_code ?? null,
    error_events: eventsOfType(ordered, "error").map((event) => ({
      scope: event.scope,
      message: event.message,
      recoverable: event.recoverable,
    })),
  };
}
