// Approval resume (LOT-104, design brief F): a run parked at
// awaiting_approval is finished here after the approver decides. The gate
// is re-entered, not bypassed: decideApproval writes the record, and
// gateExecuteAction's approved/rejected short-circuits do the rest, so the
// same code path that parked the run is the only thing that can finish it.
//
// Hardened at the milestone review (three independent findings):
//  - the decision must name the approval it was made against; a stale id
//    from before a revision is refused, never silently re-targeted
//  - an atomic claim key makes concurrent decisions single-winner, so the
//    executor cannot run twice
//  - executor failure ends the run honestly (error event + run.end
//    outcome "error") instead of bricking it behind a decided approval

import {
  MAX_REVISIONS,
  RunStateMachine,
  TraceWriter,
  createApproval,
  decideApproval,
  gateExecuteAction,
  getApprovalForRun,
  nodeIds,
  traceKeys,
  type RunOutcome,
  type Store,
} from "@novagait/agent";
import type { MockBackend } from "@novagait/mock-backend";
import { buildExecutor, readExecution, type DraftExecution } from "./execute";

export interface ApprovalDecisionInput {
  // The approval id the approver actually acted on (from the URL). Must
  // match the run's current pending approval or the decision is refused.
  approvalId: string;
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
const CLAIM_TTL_SECONDS = 24 * 60 * 60;

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
  if (approval.approval_id !== input.approvalId) {
    throw new Error(
      `approval ${input.approvalId} is superseded; the pending approval is ${approval.approval_id}`,
    );
  }
  const execution = readExecution(machine.state.data.execution);
  if (!execution) {
    throw new Error(`run ${runId} has no valid stashed execution`);
  }

  // Edits are validated, never silently dropped: a malformed edit refuses
  // the decision so the approver can correct it.
  let edits: { gl_code?: string; pay_date?: string } | undefined;
  if (input.decision === "edit_approve") {
    edits = {};
    if (input.edits?.gl_code !== undefined) {
      if (!GL_CODE_RE.test(input.edits.gl_code)) {
        throw new Error(`invalid edit: gl_code must be 4 digits`);
      }
      edits.gl_code = input.edits.gl_code;
    }
    if (input.edits?.pay_date !== undefined) {
      if (!DATE_RE.test(input.edits.pay_date)) {
        throw new Error(`invalid edit: pay_date must be YYYY-MM-DD`);
      }
      edits.pay_date = input.edits.pay_date;
    }
  }

  // Single-winner claim: concurrent decisions on the same approval lose
  // here, before anything is persisted or executed.
  const claims = await store.incrBy(
    `approval:claim:${approval.approval_id}`,
    1,
    CLAIM_TTL_SECONDS,
  );
  if (claims > 1) {
    throw new Error(
      `approval ${approval.approval_id} is already being decided`,
    );
  }

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

  // The parked segment's run.end zeroed nothing (mock lane costs are 0),
  // but carry the recorded totals forward so a resumed run's final summary
  // never erases what the first segment measured.
  const summary = await store.hgetall(traceKeys.run(runId));
  const priorCost = Number(summary?.total_cost_micro_usd ?? 0);
  const priorIterations = Number(summary?.iteration_count ?? 0);

  const finish = async (outcome: RunOutcome): Promise<ResumeResult> => {
    await writer.append({
      type: "run.end",
      node_id: nodeIds.run(),
      outcome,
      total_cost_micro_usd: priorCost,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      iteration_count: priorIterations,
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
  try {
    const outcome = await gate({ draft_ref: approval.draft_ref });
    if (outcome.status !== "executed") {
      throw new Error(`gate did not execute: ${outcome.status}`);
    }
  } catch (error) {
    // The human approved but execution failed: say exactly that. The
    // approval record stays decided (that is what happened); the run ends
    // as an error with the cause in the trace.
    await writer.append({
      type: "error",
      node_id: nodeIds.error("resume.execute"),
      scope: "resume.execute",
      message: String(error),
      recoverable: false,
    });
    await machine.transition("error", { message: String(error) });
    await writer.append({
      type: "run.end",
      node_id: nodeIds.run(),
      outcome: "error",
      total_cost_micro_usd: priorCost,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      iteration_count: priorIterations,
      failure_code: String(error).slice(0, 120),
    });
    return { runId, outcome: "error" };
  }
  await machine.transition("executed", {
    executed_with_edits: edits ?? null,
  });
  return finish("executed");
}
