// Trace event schema, version 2 (spec 08; v1 frozen 2026-08-10).
// Post-freeze changes bump the version and require a migration note in the
// architecture doc. Unknown extra fields are allowed on read (forward
// compatibility); missing required fields fail validation (the replay lane
// depends on this).
//
// MIGRATION v1 -> v2 (2026-08-10, milestone review; full note in the arch
// doc at LOT-110):
//   - `error` event type ADDED. v1 had no way to represent a failure; every
//     v2 writer records faults honestly (scope, message, recoverable).
//   - `EventBase.mode` formalized (introduced additively-optional in late
//     v1 traces; unchanged shape).
//   Validation is type-driven, so v1 traces remain valid v2 reads; v2
//   traces read by a v1-era validator fail only on `error` events.

import type { Redactable } from "./redact";

export const TRACE_SCHEMA_VERSION = 2;

export type RunMode = "shadow" | "assisted" | "autonomous";

export type RunOutcome =
  | "executed"
  | "held"
  | "rejected"
  | "awaiting_approval"
  | "cost_capped"
  | "iteration_capped"
  | "error";

export interface EventBase {
  run_id: string;
  node_id: string;
  ts: string; // ISO-8601 with offset
  seq: number; // monotonic per run, starts at 0
  trace_schema_version: number;
  // Additive-optional within v1 (LOT-102): the run's mode echoed onto every
  // event so any event is self-describing. Optional keeps replay validation
  // and old traces valid (missing required fails; extra/optional does not);
  // the v1 freeze is unbroken. Documented in the arch doc at LOT-110.
  mode?: RunMode;
}

export type TraceEvent = EventBase &
  (
    | {
        type: "run.start";
        mode: RunMode;
        input_ref: string;
        prompt_version: string;
        tools_version: string;
        model: string;
        sdk_version: string;
      }
    | {
        type: "guardrail.check";
        rule_id: string;
        input_digest: string;
        verdict: "pass" | "block";
        action_taken: string;
      }
    | {
        type: "model.request";
        model: string;
        iteration: number;
        message_count: number;
        est_input_tokens: number;
      }
    | {
        type: "model.response";
        model: string;
        stop_reason: string;
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
        cost_micro_usd: number;
        latency_ms: number;
      }
    | {
        type: "tool.call";
        name: string;
        args: Record<string, Redactable>;
        result_summary: string;
        duration_ms: number;
        attempt: number;
      }
    | {
        type: "error";
        // Where it broke, e.g. "execute.payment_schedule", "pipeline".
        scope: string;
        message: string;
        // true: handled and the run continued (e.g. a retried write);
        // false: the failure ended the run (expect run.end outcome "error").
        recoverable: boolean;
      }
    | { type: "memory.read"; store: string; key: string; hit: boolean }
    | {
        type: "memory.write";
        store: string;
        key: string;
        field_diff: Record<string, Redactable>;
      }
    | {
        type: "approval.requested";
        approval_id: string;
        route: string;
        draft_digest: string;
        policy_line: string;
      }
    | {
        type: "approval.decided";
        approval_id: string;
        actor: string;
        decision: "approve" | "reject" | "edit_approve";
        reason: string;
      }
    | {
        type: "backend.write";
        table: string;
        row_id: string;
        simulated: boolean;
      }
    | {
        type: "run.end";
        outcome: RunOutcome;
        total_cost_micro_usd: number;
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
        iteration_count: number;
        failure_code: string | null;
      }
  );

// Distributive omit: a plain Omit over the union would collapse it to the
// shared fields and drop every variant's own payload.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type TraceEventInput = DistributiveOmit<
  TraceEvent,
  "run_id" | "ts" | "seq" | "trace_schema_version"
>;

const BASE_FIELDS = ["run_id", "node_id", "ts", "seq", "trace_schema_version"];

const REQUIRED_BY_TYPE: Record<string, string[]> = {
  "run.start": [
    "mode",
    "input_ref",
    "prompt_version",
    "tools_version",
    "model",
    "sdk_version",
  ],
  "guardrail.check": ["rule_id", "input_digest", "verdict", "action_taken"],
  "model.request": ["model", "iteration", "message_count", "est_input_tokens"],
  "model.response": [
    "model",
    "stop_reason",
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "cost_micro_usd",
    "latency_ms",
  ],
  "tool.call": ["name", "args", "result_summary", "duration_ms", "attempt"],
  error: ["scope", "message", "recoverable"],
  "memory.read": ["store", "key", "hit"],
  "memory.write": ["store", "key", "field_diff"],
  "approval.requested": ["approval_id", "route", "draft_digest", "policy_line"],
  "approval.decided": ["approval_id", "actor", "decision", "reason"],
  "backend.write": ["table", "row_id", "simulated"],
  "run.end": [
    "outcome",
    "total_cost_micro_usd",
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "iteration_count",
    "failure_code",
  ],
};

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateTraceEvent(candidate: unknown): ValidationResult {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    return { valid: false, errors: ["event is not an object"] };
  }
  const event = candidate as Record<string, unknown>;
  const type = event.type;
  if (typeof type !== "string" || !(type in REQUIRED_BY_TYPE)) {
    errors.push(`unknown or missing event type: ${String(type)}`);
    return { valid: false, errors };
  }
  for (const field of BASE_FIELDS) {
    if (!(field in event) || event[field] === undefined) {
      errors.push(`missing base field: ${field}`);
    }
  }
  for (const field of REQUIRED_BY_TYPE[type]) {
    if (!(field in event) || event[field] === undefined) {
      errors.push(`missing required field for ${type}: ${field}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// Stable node_id builders (spec 08 §1).
export const nodeIds = {
  ingest: () => "ingest",
  guardrail: (rule: string) => `guardrail[${rule}]`,
  model: (iteration: number) => `agent.iter[${iteration}].model`,
  tool: (iteration: number, name: string) =>
    `agent.iter[${iteration}].tool[${name}]`,
  memory: (store: string) => `memory[${store}]`,
  approval: () => "approval",
  execute: (step: string) => `execute[${step}]`,
  error: (scope: string) => `error[${scope}]`,
  run: () => "run",
} as const;
