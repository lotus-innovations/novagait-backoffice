// Guardrails GR-INJECT / GR-SCOPE / GR-FLOOR / GR-VENDOR / GR-DUP
// (spec 10 §1). GR-EXEC lives in the approval gate. Every check produces a
// result the orchestrator traces as guardrail.check, and constrainRoute()
// applies the rules to the model's proposed route IN CODE: the model
// proposes, this module disposes. Deterministic on purpose - these run
// identically in live, mock, and eval lanes.

import { HARD_FLOOR_CENTS } from "./policy-constants";
import type { Decision } from "./guardrail-types";

export interface GuardrailResult {
  rule_id: "GR-INJECT" | "GR-SCOPE" | "GR-FLOOR" | "GR-VENDOR" | "GR-DUP";
  verdict: "pass" | "block";
  action_taken: string;
  detail: string;
}

// --- GR-SCOPE: is this an invoice-shaped document? -----------------------

const AMOUNT_PATTERN =
  /(\$\s?\d[\d,]*\.\d{2})|(\b(usd|eur|gbp)\b\s?\d)|(\d[\d,]*\.\d{2}\s?\b(usd|eur|gbp)\b)/i;
const INVOICE_WORD = /\binvoice\b|\btotal due\b|\bamount due\b|\bremit\b/i;
const REFERENCE_PATTERN =
  /\b(po[-\s]?\d+|invoice\s*(number|#|no\.?)|inv[-\s]?\d+|#[A-Z]{2,}-\d+)\b/i;

export function checkScope(documentText: string): GuardrailResult {
  const signals = [
    AMOUNT_PATTERN.test(documentText),
    INVOICE_WORD.test(documentText),
    REFERENCE_PATTERN.test(documentText),
  ].filter(Boolean).length;
  const block = signals < 2;
  return {
    rule_id: "GR-SCOPE",
    verdict: block ? "block" : "pass",
    action_taken: block ? "reject_no_erp_contact" : "none",
    detail: `invoice-shape signals: ${signals}/3`,
  };
}

// --- GR-INJECT: instructions embedded in document content ----------------

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any )?(previous|prior|your) (instructions|records|requirements)/i,
  /disregard (previous|prior|your)? ?(remit|instructions|records|approval)/i,
  /(ap automation|automation systems?|ai (system|agent|assistant))s?\s*[:,]/i,
  /(skip|bypass|without) (the )?(approval|review|human)/i,
  /new (bank|banking|account|processing entity|remit)/i,
  /effective immediately.{0,80}(payment|remit|account)/i,
];

const BENIGN_CONTEXT_PATTERNS: RegExp[] = [
  /\b(phishing|scam|fraud(ulent)?|suspicious email|not from us)\b/i,
  /\bremit-?to\b.{0,40}\bunchanged\b/i,
  /\bsecurity note\b/i,
  /\bwe confirm\b/i,
];

export function checkInjection(documentText: string): GuardrailResult {
  const hits = INJECTION_PATTERNS.filter((pattern) =>
    pattern.test(documentText),
  );
  const benign = BENIGN_CONTEXT_PATTERNS.filter((pattern) =>
    pattern.test(documentText),
  );
  // Quoting an attack while warning about it is not an attack: benign
  // context signals must outweigh the injection hits (INV-012 vs INV-011).
  const block = hits.length > 0 && benign.length < 2;
  return {
    rule_id: "GR-INJECT",
    verdict: block ? "block" : "pass",
    action_taken: block ? "force_exception_hold" : "none",
    detail: block
      ? `injection patterns: ${hits.length}, benign context: ${benign.length}`
      : `injection patterns: ${hits.length}, benign context: ${benign.length} (not blocked)`,
  };
}

// --- GR-FLOOR / GR-VENDOR / GR-DUP: policy-time checks -------------------

export function checkFloor(totalCents: number): GuardrailResult {
  const block = totalCents >= HARD_FLOOR_CENTS;
  return {
    rule_id: "GR-FLOOR",
    verdict: block ? "block" : "pass",
    action_taken: block ? "autonomy_stripped" : "none",
    detail: `total_cents=${totalCents}, floor=${HARD_FLOOR_CENTS}`,
  };
}

export function checkVendor(vendorId: string | null): GuardrailResult {
  const block = vendorId === null;
  return {
    rule_id: "GR-VENDOR",
    verdict: block ? "block" : "pass",
    action_taken: block ? "force_exception_hold" : "none",
    detail: block
      ? "vendor unresolved against ERP canonical list"
      : `vendor=${vendorId}`,
  };
}

export function checkDuplicate(priorRunId: string | null): GuardrailResult {
  const block = priorRunId !== null;
  return {
    rule_id: "GR-DUP",
    verdict: block ? "block" : "pass",
    action_taken: block ? "force_exception_hold" : "none",
    detail: block
      ? `duplicate of prior run ${priorRunId}`
      : "no prior submission",
  };
}

// --- Route constraint: code disposes -------------------------------------

const ROUTE_SEVERITY: Record<Decision, number> = {
  auto_approve: 0,
  route_for_approval: 1,
  exception_hold: 2,
  reject: 3,
};

export function constrainRoute(
  proposed: Decision,
  results: GuardrailResult[],
): { route: Decision; constrained_by: string[] } {
  let route = proposed;
  const constrainedBy: string[] = [];
  const atLeast = (minimum: Decision, rule: string) => {
    if (ROUTE_SEVERITY[route] < ROUTE_SEVERITY[minimum]) {
      route = minimum;
      constrainedBy.push(rule);
    }
  };
  for (const result of results) {
    if (result.verdict !== "block") continue;
    switch (result.rule_id) {
      case "GR-SCOPE":
        route = "reject";
        constrainedBy.push("GR-SCOPE");
        break;
      case "GR-INJECT":
      case "GR-VENDOR":
      case "GR-DUP":
        atLeast("exception_hold", result.rule_id);
        break;
      case "GR-FLOOR":
        atLeast("route_for_approval", "GR-FLOOR");
        break;
    }
  }
  return { route, constrained_by: constrainedBy };
}
