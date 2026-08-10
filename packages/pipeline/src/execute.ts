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
      } catch {
        // Transient failure (failure toggle): alert lands in the trace,
        // one retry, success. The "integration is real" beat.
        await writer.append({
          type: "backend.write",
          node_id: nodeIds.execute("payment_schedule"),
          table: "payment_schedule",
          row_id: "(transient failure, retrying)",
          simulated,
        });
        await backend.schedulePayment(paymentRow);
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
