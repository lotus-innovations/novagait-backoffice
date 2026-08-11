// Approval gate = GR-EXEC (spec 10 §1-2, design brief F). The gate is code,
// not a prompt: gateExecuteAction() wraps the real execute executor, checks
// mode + policy + approval state server-side, and returns awaiting_approval
// instead of executing when requirements are unsatisfied. No model output
// can reach the backend around it - eval family GRD-004 proves it.

import { checkFloor, type GuardrailResult } from "./guardrails";
import type { Decision } from "./guardrail-types";
import { AUTONOMY_CAP_CENTS, HARD_FLOOR_CENTS } from "./policy-constants";
import type { Store } from "./store";
import type { RunMode } from "./trace";
import { ulid } from "./ulid";

// --- Autonomy policy (pure, spec 10 §2) ----------------------------------

export interface AutonomyContext {
  route: Decision;
  totalCents: number;
  vendorId: string | null;
  guardrailBlocks: GuardrailResult[]; // results with verdict === "block"
  mode: RunMode;
}

export function canAutoApprove(context: AutonomyContext): {
  allowed: boolean;
  reason: string;
} {
  if (context.mode !== "autonomous") {
    return {
      allowed: false,
      reason: `mode is ${context.mode}; autonomy applies only in autonomous mode`,
    };
  }
  if (context.route !== "auto_approve") {
    return {
      allowed: false,
      reason: `route is ${context.route}; only auto_approve is autonomy-eligible`,
    };
  }
  if (context.vendorId === null) {
    return {
      allowed: false,
      reason: "vendor unresolved; unknown vendors always require a human",
    };
  }
  if (
    context.totalCents >= HARD_FLOOR_CENTS ||
    checkFloor(context.totalCents).verdict === "block"
  ) {
    return {
      allowed: false,
      reason: `total ${context.totalCents} cents is at/above the $${HARD_FLOOR_CENTS / 100} hard floor; approval is always human`,
    };
  }
  if (context.totalCents > AUTONOMY_CAP_CENTS) {
    return {
      allowed: false,
      reason: `total ${context.totalCents} cents exceeds the $${AUTONOMY_CAP_CENTS / 100} autonomy cap`,
    };
  }
  const blocks = context.guardrailBlocks.filter((g) => g.verdict === "block");
  if (blocks.length > 0) {
    return {
      allowed: false,
      reason: `guardrail block active: ${blocks.map((g) => g.rule_id).join(", ")}`,
    };
  }
  return {
    allowed: true,
    reason: `full match, known vendor, ${context.totalCents} cents <= cap, no guardrail blocks`,
  };
}

// --- Approval records ----------------------------------------------------

export type ApprovalStatus =
  "pending" | "approved" | "rejected" | "edit_approved";

export interface ApprovalRecord {
  approval_id: string;
  run_id: string;
  draft_ref: string;
  route: Decision;
  status: ApprovalStatus;
  actor: string | null;
  reason: string | null;
  requested_at: string;
  decided_at: string | null;
  // Edit-then-approve payload (LOT-104): the approver's corrections to the
  // drafted payment, applied at execution.
  edits?: { gl_code?: string; pay_date?: string } | null;
}

const APPROVAL_TTL_SECONDS = 24 * 60 * 60;
export const approvalKey = (id: string) => `approval:${id}`;
export const runApprovalKey = (runId: string) => `approval:by-run:${runId}`;

export async function createApproval(
  store: Store,
  init: { run_id: string; draft_ref: string; route: Decision },
): Promise<ApprovalRecord> {
  const record: ApprovalRecord = {
    approval_id: `APR-${ulid()}`,
    run_id: init.run_id,
    draft_ref: init.draft_ref,
    route: init.route,
    status: "pending",
    actor: null,
    reason: null,
    requested_at: new Date().toISOString(),
    decided_at: null,
  };
  await store.set(
    approvalKey(record.approval_id),
    JSON.stringify(record),
    APPROVAL_TTL_SECONDS,
  );
  await store.set(
    runApprovalKey(init.run_id),
    record.approval_id,
    APPROVAL_TTL_SECONDS,
  );
  return record;
}

export async function getApproval(
  store: Store,
  approvalId: string,
): Promise<ApprovalRecord | null> {
  const raw = await store.get(approvalKey(approvalId));
  return raw ? (JSON.parse(raw) as ApprovalRecord) : null;
}

export async function getApprovalForRun(
  store: Store,
  runId: string,
): Promise<ApprovalRecord | null> {
  const approvalId = await store.get(runApprovalKey(runId));
  return approvalId ? getApproval(store, approvalId) : null;
}

export async function decideApproval(
  store: Store,
  approvalId: string,
  decision: {
    actor: string;
    decision: "approve" | "reject" | "edit_approve";
    reason: string;
    edits?: { gl_code?: string; pay_date?: string };
  },
): Promise<ApprovalRecord> {
  const record = await getApproval(store, approvalId);
  if (!record) throw new Error(`unknown approval: ${approvalId}`);
  if (record.status !== "pending") {
    throw new Error(`approval ${approvalId} already decided: ${record.status}`);
  }
  record.status =
    decision.decision === "approve"
      ? "approved"
      : decision.decision === "edit_approve"
        ? "edit_approved"
        : "rejected";
  record.actor = decision.actor;
  record.reason = decision.reason;
  record.edits =
    decision.decision === "edit_approve" ? (decision.edits ?? null) : null;
  record.decided_at = new Date().toISOString();
  await store.set(
    approvalKey(approvalId),
    JSON.stringify(record),
    APPROVAL_TTL_SECONDS,
  );
  return record;
}

// --- The gate itself (GR-EXEC) -------------------------------------------

export interface GateContext {
  store: Store;
  runId: string;
  mode: RunMode;
  autonomy: AutonomyContext;
}

export type GateOutcome =
  | { status: "executed"; simulated: boolean; detail: string }
  | { status: "awaiting_approval"; approval_id: string; reason: string }
  | { status: "approval_rejected"; approval_id: string; reason: string };

// Wraps the real execute implementation. realExecute receives the simulated
// flag so shadow mode exercises the same code path with backend writes
// marked simulated (spec 10 §3).
export function gateExecuteAction(
  context: GateContext,
  realExecute: (simulated: boolean) => Promise<string>,
) {
  return async (input: { draft_ref: string }): Promise<GateOutcome> => {
    if (context.mode === "shadow") {
      const detail = await realExecute(true);
      return { status: "executed", simulated: true, detail };
    }

    const existing = await getApprovalForRun(context.store, context.runId);
    if (
      existing?.status === "approved" ||
      existing?.status === "edit_approved"
    ) {
      const detail = await realExecute(false);
      return { status: "executed", simulated: false, detail };
    }
    if (existing?.status === "rejected") {
      return {
        status: "approval_rejected",
        approval_id: existing.approval_id,
        reason: existing.reason ?? "rejected",
      };
    }
    if (existing?.status === "pending") {
      return {
        status: "awaiting_approval",
        approval_id: existing.approval_id,
        reason: "approval already requested and still pending",
      };
    }

    const autonomy = canAutoApprove(context.autonomy);
    if (autonomy.allowed) {
      const detail = await realExecute(false);
      return { status: "executed", simulated: false, detail };
    }

    const record = await createApproval(context.store, {
      run_id: context.runId,
      draft_ref: input.draft_ref,
      route: context.autonomy.route,
    });
    return {
      status: "awaiting_approval",
      approval_id: record.approval_id,
      reason: autonomy.reason,
    };
  };
}
