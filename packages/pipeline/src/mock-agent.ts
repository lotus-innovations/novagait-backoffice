// Mock-agent lane (LOT-98, Demo 2 MOCK_AGENT pattern). Runs the REAL
// executors, guardrails, state machine, approval gate, and trace writer
// end to end with no model and no key: this is what CI, previews, and e2e
// exercise. Deterministic by construction.

import { createHash } from "node:crypto";
import {
  PROMPT_VERSION,
  RunStateMachine,
  TOOLS_VERSION,
  TraceWriter,
  checkDuplicate,
  checkFloor,
  checkInjection,
  checkScope,
  checkVendor,
  constrainRoute,
  decideApproval,
  gateExecuteAction,
  nodeIds,
  type GateOutcome,
  type GuardrailResult,
  type RunMode,
  type RunOutcome,
  type Store,
} from "@novagait/agent";
import { MockBackend } from "@novagait/mock-backend";
import { decideRoute, matchInvoice } from "./match";
import { parseFixture } from "./parse";

export const MOCK_MODEL_ID = "mock-agent";

export function isMockMode(): boolean {
  return process.env.MOCK_AGENT === "1" || !process.env.ANTHROPIC_API_KEY;
}

export interface MockPipelineOptions {
  store: Store;
  backend: MockBackend;
  inboxItemId: string;
  mode: RunMode;
  // "script": deterministic approver approves pending gates (video/e2e).
  approver?: "script" | "none";
}

export interface MockPipelineResult {
  runId: string;
  outcome: RunOutcome;
  route: string | null;
  approvalId: string | null;
}

export async function runMockPipeline(
  options: MockPipelineOptions,
): Promise<MockPipelineResult> {
  const { store, backend, mode } = options;
  const item = await backend.getInboxItem(options.inboxItemId);
  if (!item) throw new Error(`unknown inbox item: ${options.inboxItemId}`);
  const text = await backend.readFixture(item.fixture);
  const digest = createHash("sha256")
    .update(text.replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16);

  const writer = new TraceWriter(store);
  const machine = await RunStateMachine.create(store, {
    run_id: writer.runId,
    mode,
    input_ref: item.fixture,
  });
  await backend.setInboxState(item.id, "processing");

  await writer.append({
    type: "run.start",
    node_id: nodeIds.run(),
    mode,
    input_ref: item.fixture,
    prompt_version: PROMPT_VERSION,
    tools_version: TOOLS_VERSION,
    model: MOCK_MODEL_ID,
    sdk_version: "mock",
  });

  const traceGuardrail = async (result: GuardrailResult) => {
    await writer.append({
      type: "guardrail.check",
      node_id: nodeIds.guardrail(result.rule_id),
      rule_id: result.rule_id,
      input_digest: digest,
      verdict: result.verdict,
      action_taken: result.action_taken,
    });
    return result;
  };

  const traceCall = async <T>(
    name: string,
    iteration: number,
    args: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const started = Date.now();
    const output = await fn();
    await writer.append({
      type: "tool.call",
      node_id: nodeIds.tool(iteration, name),
      name,
      args: args as never,
      result_summary: JSON.stringify(output).slice(0, 160),
      duration_ms: Date.now() - started,
      attempt: 1,
    });
    return output;
  };

  const finish = async (
    outcome: RunOutcome,
    route: string | null,
    approvalId: string | null,
  ): Promise<MockPipelineResult> => {
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
    return { runId: writer.runId, outcome, route, approvalId };
  };

  // --- document screens (pre-model in the live lane) ---------------------
  const scope = await traceGuardrail(checkScope(text));
  if (scope.verdict === "block") {
    await backend.saveDisposition({
      id: `DSP-${writer.runId.slice(-6)}`,
      run_id: writer.runId,
      kind: "rejection_note",
      summary: "Not an invoice-shaped document; no ERP contact (GR-SCOPE).",
      created_at: new Date().toISOString(),
    });
    await machine.transition("rejected", { guardrail: "GR-SCOPE" });
    await backend.setInboxState(item.id, "rejected");
    return finish("rejected", "reject", null);
  }
  const injection = await traceGuardrail(checkInjection(text));

  // --- extraction + lookups (real executor logic, traced) ----------------
  await machine.transition("extracted");
  const vendors = await backend.listVendors();
  const extraction = parseFixture(text, vendors);

  const resolution = await traceCall(
    "lookup_vendor",
    0,
    { name_raw: extraction.vendor_name_raw },
    async () => extraction.vendor_id,
  );

  const po = extraction.po_reference
    ? await traceCall("lookup_po", 0, { po_id: extraction.po_reference }, () =>
        backend.getPurchaseOrder(extraction.po_reference!),
      )
    : null;
  const receiving =
    po && po.type === "goods"
      ? await traceCall("lookup_receiving", 0, { po_id: po.id }, () =>
          backend.getReceivingForPo(po.id),
        )
      : null;

  const priorSeen = await store.get(`seen:${digest}`);
  const ledgerDup =
    extraction.vendor_id !== null &&
    (await backend.invoiceExists(
      extraction.vendor_id,
      extraction.invoice_number,
    ));
  const duplicateOf = priorSeen ?? (ledgerDup ? "erp-ledger" : null);
  await traceCall(
    "check_duplicate",
    0,
    {
      vendor_id: extraction.vendor_id,
      invoice_number: extraction.invoice_number,
      content_digest: digest,
    },
    async () => ({ duplicate: duplicateOf !== null, prior: duplicateOf }),
  );
  await store.set(`seen:${digest}`, writer.runId, 24 * 60 * 60);

  await machine.transition("matched");
  const match = matchInvoice(extraction, po, receiving);

  // --- policy guardrails + route (code disposes) -------------------------
  const guardrails = [
    injection,
    await traceGuardrail(checkFloor(extraction.total_cents)),
    await traceGuardrail(checkVendor(resolution)),
    await traceGuardrail(checkDuplicate(duplicateOf)),
  ];
  const proposed = decideRoute({
    match,
    totalCents: extraction.total_cents,
    vendorId: resolution,
    duplicate: duplicateOf !== null,
  });
  const constrained = constrainRoute(proposed.route, guardrails);
  const route = constrained.route;
  const policyLine =
    constrained.constrained_by.length > 0
      ? `${proposed.reason}; constrained by ${constrained.constrained_by.join(", ")}`
      : proposed.reason;

  const draftRef = await traceCall(
    "draft_action",
    1,
    { route, summary: policyLine },
    async () => {
      const ref = `DSP-${writer.runId.slice(-6)}`;
      await backend.saveDisposition({
        id: ref,
        run_id: writer.runId,
        kind:
          route === "exception_hold"
            ? "vendor_email_draft"
            : route === "reject"
              ? "rejection_note"
              : "payment_draft",
        summary: policyLine,
        created_at: new Date().toISOString(),
      });
      return ref;
    },
  );

  await machine.transition("decided", { route, policy_line: policyLine });

  if (route === "reject") {
    await machine.transition("rejected");
    await backend.setInboxState(item.id, "rejected");
    return finish("rejected", route, null);
  }
  if (route === "exception_hold") {
    await machine.transition("held", { exceptions: match.exceptions });
    await backend.setInboxState(item.id, "held");
    return finish("held", route, null);
  }

  // --- approve routes: through the gate (GR-EXEC) ------------------------
  const gate = gateExecuteAction(
    {
      store,
      runId: writer.runId,
      mode,
      autonomy: {
        route,
        totalCents: extraction.total_cents,
        vendorId: resolution,
        guardrailBlocks: guardrails.filter((g) => g.verdict === "block"),
        mode,
      },
    },
    async (simulated) => {
      const vendor = vendors.find((v) => v.id === resolution)!;
      if (!simulated) {
        await backend.postToLedger({
          id: `LED-${writer.runId.slice(-6)}`,
          vendor_id: vendor.id,
          invoice_number: extraction.invoice_number,
          amount_cents: extraction.total_cents,
          posted_date: new Date().toISOString().slice(0, 10),
          run_id: writer.runId,
        });
      }
      await writer.append({
        type: "backend.write",
        node_id: nodeIds.execute("ledger"),
        table: "ledger",
        row_id: `LED-${writer.runId.slice(-6)}`,
        simulated,
      });
      const paymentRow = {
        id: `PAY-${writer.runId.slice(-6)}`,
        vendor_id: vendor.id,
        amount_cents: extraction.total_cents,
        gl_code: vendor.default_gl_code,
        pay_date: extraction.due_date ?? new Date().toISOString().slice(0, 10),
        run_id: writer.runId,
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
        await backend.setInboxState(item.id, "processed");
      }
      await writer.append({
        type: "backend.write",
        node_id: nodeIds.execute("payment_schedule"),
        table: "payment_schedule",
        row_id: paymentRow.id,
        simulated,
      });
      return JSON.stringify({
        ledger: `LED-${writer.runId.slice(-6)}`,
        payment: paymentRow.id,
      });
    },
  );

  const runGate = (): Promise<GateOutcome> =>
    traceCall("execute_action", 2, { draft_ref: draftRef }, () =>
      gate({ draft_ref: draftRef }),
    );

  let gateOutcome = await runGate();

  if (gateOutcome.status === "awaiting_approval") {
    await machine.transition("awaiting_approval", {
      approval_id: gateOutcome.approval_id,
    });
    await writer.append({
      type: "approval.requested",
      node_id: nodeIds.approval(),
      approval_id: gateOutcome.approval_id,
      route,
      draft_digest: digest,
      policy_line: gateOutcome.reason,
    });
    if (options.approver === "script") {
      await decideApproval(store, gateOutcome.approval_id, {
        actor: "script",
        decision: "approve",
        reason: "scripted approver",
      });
      await writer.append({
        type: "approval.decided",
        node_id: nodeIds.approval(),
        approval_id: gateOutcome.approval_id,
        actor: "script",
        decision: "approve",
        reason: "scripted approver",
      });
      gateOutcome = await runGate();
    } else {
      return finish("awaiting_approval", route, gateOutcome.approval_id);
    }
  }

  if (gateOutcome.status === "executed") {
    const approvalId =
      machine.state.data.approval_id === undefined
        ? null
        : String(machine.state.data.approval_id);
    await machine.transition("executed");
    return finish("executed", route, approvalId);
  }

  await machine.transition("held", { approval_rejected: true });
  return finish("held", route, null);
}
