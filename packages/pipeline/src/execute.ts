// The real execute step behind the gate (LOT-104): shared by the first
// pass (mock-agent) and the approval resume so the two can never drift.
// Posts the ledger row, schedules the payment (transient-failure retry
// visible in the trace), marks the inbox item processed, and traces every
// backend write with the simulated flag.

import { nodeIds, type TraceWriter } from "@novagait/agent";
import type { MockBackend } from "@novagait/mock-backend";

// The execution essentials stashed in run state at the `decided`
// transition; everything a resume needs to execute the drafted action.
export interface DraftExecution {
  vendor_id: string;
  invoice_number: string;
  total_cents: number;
  gl_code: string;
  pay_date: string;
  inbox_item_id: string;
}

/**
 * Validate a run-state execution stash before it reaches the executor
 * (review fix: the stash crosses a JSON boundary, so a bare cast could
 * schedule a payment from a partially-shaped object).
 */
export function readExecution(value: unknown): DraftExecution | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const valid =
    typeof v.vendor_id === "string" &&
    typeof v.invoice_number === "string" &&
    Number.isInteger(v.total_cents) &&
    typeof v.gl_code === "string" &&
    typeof v.pay_date === "string" &&
    typeof v.inbox_item_id === "string";
  return valid ? (value as DraftExecution) : null;
}

export function buildExecutor(deps: {
  backend: MockBackend;
  writer: TraceWriter;
  execution: DraftExecution;
}): (simulated: boolean) => Promise<string> {
  const { backend, writer, execution } = deps;
  const runId = writer.runId;
  return async (simulated: boolean) => {
    const ledgerRow = {
      id: `LED-${runId.slice(-6)}`,
      vendor_id: execution.vendor_id,
      invoice_number: execution.invoice_number,
      amount_cents: execution.total_cents,
      posted_date: new Date().toISOString().slice(0, 10),
      run_id: runId,
    };
    if (!simulated) {
      await backend.postToLedger(ledgerRow);
    }
    await writer.append({
      type: "backend.write",
      node_id: nodeIds.execute("ledger"),
      table: "ledger",
      row_id: ledgerRow.id,
      simulated,
    });

    const paymentRow = {
      id: `PAY-${runId.slice(-6)}`,
      vendor_id: execution.vendor_id,
      amount_cents: execution.total_cents,
      gl_code: execution.gl_code,
      pay_date: execution.pay_date,
      run_id: runId,
      status: "scheduled" as const,
    };
    if (!simulated) {
      try {
        await backend.schedulePayment(paymentRow);
      } catch (firstError) {
        // Transient failure (failure toggle): record the REAL error, retry
        // once. The "integration is real" beat - honestly this time.
        await writer.append({
          type: "error",
          node_id: nodeIds.error("execute.payment_schedule"),
          scope: "execute.payment_schedule",
          message: String(firstError),
          recoverable: true,
        });
        try {
          await backend.schedulePayment(paymentRow);
        } catch (retryError) {
          // Retry failed: surface it. The ledger row is already posted;
          // the caller ends the run as an error and the trace says why.
          await writer.append({
            type: "error",
            node_id: nodeIds.error("execute.payment_schedule"),
            scope: "execute.payment_schedule",
            message: `retry failed: ${String(retryError)}; ledger row ${ledgerRow.id} posted without a payment row`,
            recoverable: false,
          });
          throw retryError;
        }
      }
      await backend.setInboxState(execution.inbox_item_id, "processed");
    }
    await writer.append({
      type: "backend.write",
      node_id: nodeIds.execute("payment_schedule"),
      table: "payment_schedule",
      row_id: paymentRow.id,
      simulated,
    });
    return JSON.stringify({ ledger: ledgerRow.id, payment: paymentRow.id });
  };
}
