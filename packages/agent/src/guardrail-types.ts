// Decision routes (spec 07 §6). Shared by guardrails, the approval policy,
// tools, and the eval vocabulary.

export const DECISION_ROUTES = [
  "auto_approve",
  "route_for_approval",
  "exception_hold",
  "reject",
] as const;

export type Decision = (typeof DECISION_ROUTES)[number];
