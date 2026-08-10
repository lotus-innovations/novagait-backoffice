// End-to-end mock lane (LOT-98): real executor logic, guardrails, state
// machine, approval gate, trace writer, and mock backend, zero key.

import { beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryStore,
  RunStateMachine,
  readTrace,
  validateTraceEvent,
} from "@novagait/agent";
import { MockBackend, VENDORS } from "@novagait/mock-backend";
import { parseFixture } from "./parse";
import { runMockPipeline } from "./mock-agent";

let store: InMemoryStore;
let backend: MockBackend;

beforeEach(async () => {
  store = new InMemoryStore();
  backend = new MockBackend(store);
  await backend.seed();
});

async function trace(runId: string) {
  return readTrace(store, runId);
}

describe("parseFixture", () => {
  it("extracts the clean Corvida invoice correctly", async () => {
    const text = await backend.readFixture(
      "inbox/2026-08-03-corvida-monthly.md",
    );
    const extraction = parseFixture(text, VENDORS);
    expect(extraction.vendor_id).toBe("V-001");
    expect(extraction.invoice_number).toBe("CB-2026-0803");
    expect(extraction.total_cents).toBe(43875);
    expect(extraction.po_reference).toBe("PO-2201");
    expect(extraction.currency).toBe("USD");
    expect(extraction.invoice_date).toBe("2026-08-03");
  });
});

describe("runMockPipeline end-to-end", () => {
  it("happy path, autonomous: ingest -> executed with ERP rows and a valid trace", async () => {
    const result = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-001",
      mode: "autonomous",
    });
    expect(result.outcome).toBe("executed");
    expect(result.route).toBe("auto_approve");

    const ledger = await backend.ledgerEntries();
    expect(
      ledger.some(
        (entry) =>
          entry.invoice_number === "CB-2026-0803" &&
          entry.run_id === result.runId,
      ),
    ).toBe(true);
    expect(await backend.paymentSchedule()).toHaveLength(1);
    expect((await backend.getInboxItem("INB-001"))?.state).toBe("processed");

    const events = await trace(result.runId);
    for (const event of events) {
      expect(validateTraceEvent(event).valid, event.type).toBe(true);
    }
    const kinds = events.map((event) => event.type);
    expect(kinds[0]).toBe("run.start");
    expect(kinds.at(-1)).toBe("run.end");
    expect(kinds).toContain("guardrail.check");
    expect(kinds).toContain("tool.call");
    expect(kinds).toContain("backend.write");

    const machine = await RunStateMachine.load(store, result.runId);
    expect(machine?.state.step).toBe("executed");
  });

  it("assisted + scripted approver: pauses, approves, executes with approval events", async () => {
    const result = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-001",
      mode: "assisted",
      approver: "script",
    });
    expect(result.outcome).toBe("executed");
    const kinds = (await trace(result.runId)).map((event) => event.type);
    expect(kinds).toContain("approval.requested");
    expect(kinds).toContain("approval.decided");
    expect(await backend.paymentSchedule()).toHaveLength(1);
  });

  it("assisted without approver: parks at awaiting_approval, nothing executed", async () => {
    const result = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-001",
      mode: "assisted",
    });
    expect(result.outcome).toBe("awaiting_approval");
    expect(result.approvalId).toBeTruthy();
    expect(await backend.paymentSchedule()).toHaveLength(0);
    const machine = await RunStateMachine.load(store, result.runId);
    expect(machine?.state.step).toBe("awaiting_approval");
  });

  it("injection fixture is held by GR-INJECT with no ERP writes", async () => {
    const before = (await backend.ledgerEntries()).length;
    const result = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-011",
      mode: "autonomous",
    });
    expect(result.outcome).toBe("held");
    expect(result.route).toBe("exception_hold");
    expect((await backend.ledgerEntries()).length).toBe(before);
    const events = await trace(result.runId);
    const inject = events.find(
      (event) =>
        event.type === "guardrail.check" && event.rule_id === "GR-INJECT",
    );
    expect(inject && "verdict" in inject && inject.verdict).toBe("block");
  });

  it("newsletter is rejected by GR-SCOPE before any ERP lookup", async () => {
    const result = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-015",
      mode: "autonomous",
    });
    expect(result.outcome).toBe("rejected");
    const kinds = (await trace(result.runId)).map((event) => event.type);
    expect(kinds).not.toContain("tool.call");
    expect((await backend.getInboxItem("INB-015"))?.state).toBe("rejected");
  });

  it("duplicate resend is held by GR-DUP after the original executed", async () => {
    await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-001",
      mode: "autonomous",
    });
    const result = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-010",
      mode: "autonomous",
    });
    expect(result.outcome).toBe("held");
    const events = await trace(result.runId);
    const dup = events.find(
      (event) => event.type === "guardrail.check" && event.rule_id === "GR-DUP",
    );
    expect(dup && "verdict" in dup && dup.verdict).toBe("block");
    expect(await backend.paymentSchedule()).toHaveLength(1); // only the original
  });

  it("failure toggle: transient payment failure retries and succeeds, visible in trace", async () => {
    await backend.setFailureToggle(true);
    const result = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-001",
      mode: "autonomous",
    });
    expect(result.outcome).toBe("executed");
    expect(await backend.paymentSchedule()).toHaveLength(1);
    const paymentWrites = (await trace(result.runId)).filter(
      (event) =>
        event.type === "backend.write" &&
        "table" in event &&
        event.table === "payment_schedule",
    );
    expect(paymentWrites).toHaveLength(2); // failed attempt + success
  });

  it("shadow mode simulates execution and touches nothing", async () => {
    const before = (await backend.ledgerEntries()).length;
    const result = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-001",
      mode: "shadow",
    });
    expect(result.outcome).toBe("executed");
    expect((await backend.ledgerEntries()).length).toBe(before);
    expect(await backend.paymentSchedule()).toHaveLength(0);
    const writes = (await trace(result.runId)).filter(
      (event) => event.type === "backend.write",
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect("simulated" in write && write.simulated).toBe(true);
    }
  });
});
