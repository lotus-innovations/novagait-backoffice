// Approval resume (LOT-104, design brief F): a run parked at
// awaiting_approval is finished here after the approver decides. The gate
// is re-entered, not bypassed: decideApproval writes the record, and
// gateExecuteAction's approved/rejected short-circuits do the rest, so the
// same code path that parked the run is the only thing that can finish it.

import {
  RunStateMachine,
  TraceWriter,
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
