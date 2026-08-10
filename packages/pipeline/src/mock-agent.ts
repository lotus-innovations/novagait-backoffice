// Mock-agent lane (LOT-98, Demo 2 MOCK_AGENT pattern). Runs the REAL
// executors, guardrails, state machine, approval gate, and trace writer
// end to end with no model and no key: this is what CI, previews, and e2e
// exercise. Deterministic by construction.

import {
  DedupeLedger,
  MEMORY_STORE_NAMES,
  PROMPT_VERSION,
  RunStateMachine,
  TOOLS_VERSION,
  TraceWriter,
  VendorProfileStore,
  checkDuplicate,
  checkFloor,
  checkInjection,
  checkScope,
  checkVendor,
  constrainRoute,
  contentDigest,
  decideApproval,
  gateExecuteAction,
  nodeIds,
  searchKb,
  type GateOutcome,
  type GuardrailResult,
  type RunMode,
  type RunOutcome,
  type Store,
  type VendorProfile,
  type VendorProfileUpdate,
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
  const digest = contentDigest(text);
  const dedupe = new DedupeLedger(store);
  const profiles = new VendorProfileStore(store);

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

  const traceMemoryRead = async (
    storeName: string,
    key: string,
    hit: boolean,
  ) =>
    writer.append({
      type: "memory.read",
      node_id: nodeIds.memory(storeName),
      store: storeName,
      key,
      hit,
    });

  const traceMemoryWrite = async (
    storeName: string,
    key: string,
    fieldDiff: Record<string, string>,
  ) =>
    writer.append({
      type: "memory.write",
      node_id: nodeIds.memory(storeName),
      store: storeName,
      key,
      field_diff: fieldDiff,
    });

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

  // Vendor profile read at match time (spec 07 §9): the second run for a
  // vendor is visibly better-informed (learned GL code, history).
  let profile: VendorProfile | null = null;
  if (resolution) {
    profile = await profiles.get(resolution);
    await traceMemoryRead(
      MEMORY_STORE_NAMES.vendorProfiles,
      `vendor:${resolution}`,
      profile !== null,
    );
  }

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

  const priorSeen = await dedupe.check(digest);
  await traceMemoryRead(
    MEMORY_STORE_NAMES.dedupe,
    `seen:${digest}`,
    priorSeen !== null,
  );
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
  await dedupe.record(digest, writer.runId);
  await traceMemoryWrite(MEMORY_STORE_NAMES.dedupe, `seen:${digest}`, {
    run_id: writer.runId,
  });

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

  // Ground the policy line in the kb (LOT-94): one retrieval per run, the
  // top excerpt's citation rides along to the approver.
  const kbQuery =
    duplicateOf !== null
      ? "duplicate invoice resubmission handling"
      : resolution === null
        ? "unresolved vendor name resolution"
        : match.exceptions.includes("price_variance_exceeds_tolerance")
          ? "tolerance for price variance"
          : match.exceptions.length > 0
            ? "three-way match exceptions and holds"
            : "autonomy cap and approval authority";
  const kbHits = await traceCall("kb_search", 1, { query: kbQuery }, async () =>
    searchKb(kbQuery, 1),
  );
  const citation = kbHits[0] ? ` [${kbHits[0].citation}]` : "";

  const policyLine =
    (constrained.constrained_by.length > 0
      ? `${proposed.reason}; constrained by ${constrained.constrained_by.join(", ")}`
      : proposed.reason) + citation;

  // Bounded profile write via tool call after a completed run (spec 07 §9):
  // last_seen always, exception count on holds. Audited: tool.call +
  // memory.write both land in the trace.
  const writeVendorProfile = async (fields: VendorProfileUpdate) => {
    if (!resolution) return;
    const canonical = vendors.find((v) => v.id === resolution)?.canonical_name;
    const { diff } = await traceCall(
      "update_vendor_profile",
      3,
      { vendor_id: resolution, fields: fields as Record<string, unknown> },
      () =>
        profiles.applyUpdate(resolution, {
          ...fields,
          canonical_name: canonical,
        }),
    );
    await traceMemoryWrite(
      MEMORY_STORE_NAMES.vendorProfiles,
      `vendor:${resolution}`,
      diff,
    );
  };
  const today = new Date().toISOString().slice(0, 10);

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
    await writeVendorProfile({ last_seen: today, exception_increment: 1 });
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
        // Learned GL code from the vendor profile wins over the master
        // default (gl-coding policy).
        gl_code: profile?.learned_gl_code ?? vendor.default_gl_code,
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
    await writeVendorProfile({ last_seen: today });
    await machine.transition("executed");
    return finish("executed", route, approvalId);
  }

  await machine.transition("held", { approval_rejected: true });
  return finish("held", route, null);
}
