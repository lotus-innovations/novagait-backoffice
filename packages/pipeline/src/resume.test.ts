// Approval resume (LOT-104): park in assisted mode, decide, and the run
// finishes through the same gate that parked it.

import { beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryStore,
  RunStateMachine,
  getApprovalForRun,
  readTrace,
} from "@novagait/agent";
import { MockBackend } from "@novagait/mock-backend";
import { runMockPipeline } from "./mock-agent";
import { resumeRun } from "./resume";

let store: InMemoryStore;
let backend: MockBackend;

beforeEach(async () => {
  store = new InMemoryStore();
  backend = new MockBackend(store);
  await backend.seed();
});

async function parkRun(inboxItemId = "INB-001") {
  const result = await runMockPipeline({
    store,
    backend,
    inboxItemId,
    mode: "assisted",
  });
  expect(result.outcome).toBe("awaiting_approval");
  return result;
}

describe("resumeRun", () => {
  it("approve executes the draft with ERP rows and a continued trace", async () => {
    const parked = await parkRun();
    const resumed = await resumeRun(store, backend, parked.runId, {
      approvalId: parked.approvalId!,
      actor: "visitor:test",
      decision: "approve",
      reason: "looks right",
    });
    expect(resumed.outcome).toBe("executed");

    const payments = await backend.paymentSchedule();
    expect(payments).toHaveLength(1);
    expect(payments[0].run_id).toBe(parked.runId);
    expect((await backend.getInboxItem("INB-001"))?.state).toBe("processed");

    const events = await readTrace(store, parked.runId);
    const kinds = events.map((event) => event.type);
    expect(kinds.at(-1)).toBe("run.end");
    expect(kinds).toContain("approval.decided");
    // Two run.end events by design: parked segment + final outcome.
    expect(kinds.filter((k) => k === "run.end")).toHaveLength(2);
    // seq strictly increasing across the resume boundary.
    const seqs = events.map((event) => event.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    const machine = await RunStateMachine.load(store, parked.runId);
    expect(machine?.state.step).toBe("executed");
  });

  it("edit-then-approve applies GL and pay-date edits to the payment", async () => {
    const parked = await parkRun();
    await resumeRun(store, backend, parked.runId, {
      approvalId: parked.approvalId!,
      actor: "visitor:test",
      decision: "edit_approve",
      reason: "recode to 6150",
      edits: { gl_code: "6150", pay_date: "2026-09-01" },
    });
    const [payment] = await backend.paymentSchedule();
    expect(payment.gl_code).toBe("6150");
    expect(payment.pay_date).toBe("2026-09-01");
    const approval = await getApprovalForRun(store, parked.runId);
    expect(approval?.status).toBe("edit_approved");
    expect(approval?.edits).toEqual({
      gl_code: "6150",
      pay_date: "2026-09-01",
    });
  });

  it("edit-then-approve REFUSES malformed edits instead of executing originals", async () => {
    const parked = await parkRun();
    await expect(
      resumeRun(store, backend, parked.runId, {
        approvalId: parked.approvalId!,
        actor: "visitor:test",
        decision: "edit_approve",
        reason: "bad edits",
        edits: { gl_code: "not-a-code", pay_date: "someday" },
      }),
    ).rejects.toThrow(/invalid edit/);
    // Nothing executed; the approval is still pending and decidable.
    expect(await backend.paymentSchedule()).toHaveLength(0);
    const approval = await getApprovalForRun(store, parked.runId);
    expect(approval?.status).toBe("pending");
  });

  it("reject triggers exactly one revision, then a second reject holds", async () => {
    const parked = await parkRun();

    // First reject: the reason re-enters the loop, a revised draft parks a
    // NEW approval instead of holding (spec 10 §3).
    const revised = await resumeRun(store, backend, parked.runId, {
      approvalId: parked.approvalId!,
      actor: "visitor:test",
      decision: "reject",
      reason: "wrong PO",
    });
    expect(revised.outcome).toBe("awaiting_approval");
    expect(revised.approvalId).toBeTruthy();
    const machineAfterRevision = await RunStateMachine.load(
      store,
      parked.runId,
    );
    expect(machineAfterRevision?.state.revision_count).toBe(1);
    expect(machineAfterRevision?.state.step).toBe("awaiting_approval");

    const currentApproval = await getApprovalForRun(store, parked.runId);
    expect(currentApproval?.approval_id).toBe(revised.approvalId);
    expect(currentApproval?.status).toBe("pending");
    expect(currentApproval?.draft_ref).toMatch(/-R1$/);

    const events = await readTrace(store, parked.runId);
    const requests = events.filter((e) => e.type === "approval.requested");
    expect(requests).toHaveLength(2);
    const revisedDraftCall = events.find(
      (e) =>
        e.type === "tool.call" &&
        "args" in e &&
        (e.args as Record<string, unknown>).rejection_reason === "wrong PO",
    );
    expect(revisedDraftCall).toBeTruthy();

    // Second reject: revision exhausted, the run holds with the reason.
    const held = await resumeRun(store, backend, parked.runId, {
      approvalId: revised.approvalId!,
      actor: "visitor:test",
      decision: "reject",
      reason: "still wrong",
    });
    expect(held.outcome).toBe("held");
    expect(await backend.paymentSchedule()).toHaveLength(0);
    expect((await backend.getInboxItem("INB-001"))?.state).toBe("held");
    const machine = await RunStateMachine.load(store, parked.runId);
    expect(machine?.state.step).toBe("held");
    expect(machine?.state.data.rejection_reason).toBe("still wrong");
  });

  it("a revised approval can be approved and executes", async () => {
    const parked = await parkRun();
    const revised = await resumeRun(store, backend, parked.runId, {
      approvalId: parked.approvalId!,
      actor: "visitor:test",
      decision: "reject",
      reason: "recheck the period",
    });
    expect(revised.outcome).toBe("awaiting_approval");
    const final = await resumeRun(store, backend, parked.runId, {
      approvalId: revised.approvalId!,
      actor: "visitor:test",
      decision: "approve",
      reason: "revision addresses it",
    });
    expect(final.outcome).toBe("executed");
    expect(await backend.paymentSchedule()).toHaveLength(1);
  });

  it("stamps the run mode on every trace event, including resumed segments", async () => {
    const parked = await parkRun();
    await resumeRun(store, backend, parked.runId, {
      approvalId: parked.approvalId!,
      actor: "visitor:test",
      decision: "approve",
      reason: "ok",
    });
    const events = await readTrace(store, parked.runId);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.mode, event.type).toBe("assisted");
    }
  });

  it("refuses a stale approval id after a revision (no sight-unseen approval)", async () => {
    const parked = await parkRun();
    const revised = await resumeRun(store, backend, parked.runId, {
      approvalId: parked.approvalId!,
      actor: "visitor:test",
      decision: "reject",
      reason: "wrong PO",
    });
    expect(revised.approvalId).not.toBe(parked.approvalId);
    // A stale tab still holding the ORIGINAL approval id tries to approve.
    await expect(
      resumeRun(store, backend, parked.runId, {
        approvalId: parked.approvalId!,
        actor: "visitor:stale-tab",
        decision: "approve",
        reason: "approving what I saw earlier",
      }),
    ).rejects.toThrow(/superseded/);
    expect(await backend.paymentSchedule()).toHaveLength(0);
  });

  it("concurrent decisions are single-winner (atomic claim)", async () => {
    const parked = await parkRun();
    const decide = () =>
      resumeRun(store, backend, parked.runId, {
        approvalId: parked.approvalId!,
        actor: "visitor:test",
        decision: "approve",
        reason: "ok",
      });
    const results = await Promise.allSettled([decide(), decide()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /already being decided|not awaiting|no pending/,
    );
    // Exactly one execution.
    expect(await backend.paymentSchedule()).toHaveLength(1);
    expect(
      await backend
        .ledgerEntries()
        .then((l) => l.filter((e) => e.run_id === parked.runId)),
    ).toHaveLength(1);
  });

  it("executor failure after approval ends the run honestly, not bricked", async () => {
    const parked = await parkRun();
    const brokenBackend = backend as unknown as {
      postToLedger: () => Promise<void>;
    };
    brokenBackend.postToLedger = async () => {
      throw new Error("ledger write refused");
    };
    const result = await resumeRun(store, backend, parked.runId, {
      approvalId: parked.approvalId!,
      actor: "visitor:test",
      decision: "approve",
      reason: "ok",
    });
    expect(result.outcome).toBe("error");
    const events = await readTrace(store, parked.runId);
    const end = events.at(-1);
    expect(end?.type === "run.end" && end.outcome).toBe("error");
    expect(end?.type === "run.end" && end.failure_code).toContain(
      "ledger write refused",
    );
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent?.type === "error" && errorEvent.scope).toBe(
      "resume.execute",
    );
    // The audit trail is honest: the human DID approve; execution failed.
    const approval = await getApprovalForRun(store, parked.runId);
    expect(approval?.status).toBe("approved");
    const machine = await RunStateMachine.load(store, parked.runId);
    expect(machine?.state.step).toBe("error");
  });

  it("refuses runs that are not awaiting approval and double decisions", async () => {
    const executed = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-001",
      mode: "autonomous",
    });
    await expect(
      resumeRun(store, backend, executed.runId, {
        approvalId: "APR-whatever",
        actor: "visitor:test",
        decision: "approve",
        reason: "x",
      }),
    ).rejects.toThrow(/not awaiting/);

    // Different document: INB-001 is now in the dedupe ledger.
    const parked = await parkRun("INB-005");
    await resumeRun(store, backend, parked.runId, {
      approvalId: parked.approvalId!,
      actor: "visitor:test",
      decision: "approve",
      reason: "ok",
    });
    await expect(
      resumeRun(store, backend, parked.runId, {
        approvalId: parked.approvalId!,
        actor: "visitor:test",
        decision: "approve",
        reason: "again",
      }),
    ).rejects.toThrow(/not awaiting/);
  });
});
