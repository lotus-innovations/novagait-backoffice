// Approval resume (LOT-104, design brief F): a run parked at
// awaiting_approval is finished here after the approver decides. The gate
// is re-entered, not bypassed: decideApproval writes the record, and
// gateExecuteAction's approved/rejected short-circuits do the rest, so the
// same code path that parked the run is the only thing that can finish it.

import {
  MAX_REVISIONS,
  RunStateMachine,
  TraceWriter,
  createApproval,
  decideApproval,
  gateExecuteAction,
  getApprovalForRun,
  nodeIds,
  type RunOutcome,
  type Store,
} from "@novagait/agent";
import type { MockBackend } from "@novagait/mock-backend";
import { buildExecutor, type DraftExecution } from "./execute";

export interface ApprovalDecisionInput {
  actor: string; // e.g. "visitor:01ABC..."
  decision: "approve" | "reject" | "edit_approve";
  reason: string;
  edits?: { gl_code?: string; pay_date?: string };
}

export interface ResumeResult {
  runId: string;
  outcome: RunOutcome;
  // Set when a rejection produced a revision: the new pending approval.
  approvalId?: string | null;
}

const GL_CODE_RE = /^\d{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function resumeRun(
  store: Store,
  backend: MockBackend,
  runId: string,
  input: ApprovalDecisionInput,
): Promise<ResumeResult> {
  const machine = await RunStateMachine.load(store, runId);
  if (!machine) throw new Error(`unknown run: ${runId}`);
  if (machine.state.step !== "awaiting_approval") {
    throw new Error(`run ${runId} is not awaiting approval`);
  }
  const approval = await getApprovalForRun(store, runId);
  if (!approval || approval.status !== "pending") {
    throw new Error(`run ${runId} has no pending approval`);
  }
  const execution = machine.state.data.execution as DraftExecution | null;
  if (!execution) throw new Error(`run ${runId} has no stashed execution`);

  const edits =
    input.decision === "edit_approve"
      ? {
          ...(input.edits?.gl_code && GL_CODE_RE.test(input.edits.gl_code)
            ? { gl_code: input.edits.gl_code }
            : {}),
          ...(input.edits?.pay_date && DATE_RE.test(input.edits.pay_date)
            ? { pay_date: input.edits.pay_date }
            : {}),
        }
      : undefined;

  await decideApproval(store, approval.approval_id, {
    actor: input.actor,
    decision: input.decision,
    reason: input.reason,
    edits,
  });

  const writer = await TraceWriter.resume(store, runId);
  writer.mode = machine.state.mode;
  await writer.append({
    type: "approval.decided",
    node_id: nodeIds.approval(),
    approval_id: approval.approval_id,
    actor: input.actor,
    decision: input.decision,
    reason: input.reason,
  });

  const finish = async (outcome: RunOutcome): Promise<ResumeResult> => {
    await writer.append({
      type: "run.end",
      node_id: nodeIds.run(),
      outcome,
      total_cost_micro_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      iteration_count: 0,
      failure_code: null,
    });
    return { runId, outcome };
  };

  if (input.decision === "reject") {
    // Revision cycle (spec 10 §3): the rejection reason re-enters the loop
    // as a tool result for exactly one revision, then the run holds. The
    // state machine enforces the cap (awaiting_approval -> decided bumps
    // revision_count and throws past MAX_REVISIONS).
    if (machine.state.revision_count < MAX_REVISIONS) {
      const revisedRef = `${approval.draft_ref}-R${machine.state.revision_count + 1}`;
      const revisedLine = `revised after rejection ("${input.reason}"): ${String(
        machine.state.data.policy_line ?? "",
      )}`;
      await machine.transition("decided", {
        revised_after_rejection: input.reason,
        draft_ref: revisedRef,
      });
      await writer.append({
        type: "tool.call",
        node_id: nodeIds.tool(machine.state.revision_count, "draft_action"),
        name: "draft_action",
        args: { route: approval.route, rejection_reason: input.reason },
        result_summary: JSON.stringify({ draft_ref: revisedRef }).slice(0, 160),
        duration_ms: 0,
        attempt: 1,
      });
      await backend.saveDisposition({
        id: revisedRef,
        run_id: runId,
        kind: "payment_draft",
        summary: revisedLine,
        created_at: new Date().toISOString(),
      });
      const revised = await createApproval(store, {
        run_id: runId,
        draft_ref: revisedRef,
        route: approval.route,
      });
      await writer.append({
        type: "approval.requested",
        node_id: nodeIds.approval(),
        approval_id: revised.approval_id,
        route: approval.route,
        draft_digest: revisedRef,
        policy_line: revisedLine,
      });
      await machine.transition("awaiting_approval", {
        approval_id: revised.approval_id,
      });
      const parked = await finish("awaiting_approval");
      return { ...parked, approvalId: revised.approval_id };
    }
    await machine.transition("held", {
      approval_rejected: true,
      rejection_reason: input.reason,
    });
    await backend.setInboxState(execution.inbox_item_id, "held");
    return finish("held");
  }

  // Approve / edit-then-approve: back through the gate. The approval record
  // is now approved, so the gate's short-circuit executes the draft; edits
  // land on the payment row.
  const effective: DraftExecution = { ...execution, ...(edits ?? {}) };
  const gate = gateExecuteAction(
    {
      store,
      runId,
      mode: machine.state.mode,
      autonomy: {
        route: approval.route,
        totalCents: execution.total_cents,
        vendorId: execution.vendor_id,
        guardrailBlocks: [],
        mode: machine.state.mode,
      },
    },
    buildExecutor({ backend, writer, execution: effective }),
  );
  const outcome = await gate({ draft_ref: approval.draft_ref });
  if (outcome.status !== "executed") {
    throw new Error(`resume did not execute: ${outcome.status}`);
  }
  await machine.transition("executed", {
    executed_with_edits: edits ?? null,
  });
  return finish("executed");
}
