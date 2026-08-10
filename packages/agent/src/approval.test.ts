import { describe, expect, it } from "vitest";
import {
  canAutoApprove,
  createApproval,
  decideApproval,
  gateExecuteAction,
  getApprovalForRun,
  type AutonomyContext,
} from "./approval";
import { checkFloor, checkVendor } from "./guardrails";
import { InMemoryStore } from "./store";

const CLEAN: AutonomyContext = {
  route: "auto_approve",
  totalCents: 43875,
  vendorId: "V-001",
  guardrailBlocks: [],
  mode: "autonomous",
};

describe("canAutoApprove", () => {
  it("allows the clean autonomous case with a stated reason", () => {
    const verdict = canAutoApprove(CLEAN);
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toContain("no guardrail blocks");
  });

  it("refuses with specific reasons for every failing condition", () => {
    expect(canAutoApprove({ ...CLEAN, mode: "assisted" }).reason).toContain(
      "autonomy applies only in autonomous mode",
    );
    expect(
      canAutoApprove({ ...CLEAN, route: "route_for_approval" }).reason,
    ).toContain("only auto_approve");
    expect(canAutoApprove({ ...CLEAN, vendorId: null }).reason).toContain(
      "unknown vendors always require a human",
    );
    expect(canAutoApprove({ ...CLEAN, totalCents: 60_000 }).reason).toContain(
      "autonomy cap",
    );
    expect(canAutoApprove({ ...CLEAN, totalCents: 580_000 }).reason).toContain(
      "hard floor",
    );
    expect(
      canAutoApprove({ ...CLEAN, guardrailBlocks: [checkVendor(null)] }).reason,
    ).toContain("GR-VENDOR");
  });
});

function makeGate(
  store: InMemoryStore,
  overrides: Partial<AutonomyContext> = {},
) {
  const executed: boolean[] = [];
  const gate = gateExecuteAction(
    {
      store,
      runId: "RUN-1",
      mode: (overrides.mode ?? "assisted") as AutonomyContext["mode"],
      autonomy: { ...CLEAN, ...overrides },
    },
    async (simulated) => {
      executed.push(simulated);
      return JSON.stringify({ ledger: "LED-NEW", simulated });
    },
  );
  return { gate, executed };
}

describe("gateExecuteAction (GR-EXEC)", () => {
  it("assisted mode: pauses with an approval record instead of executing", async () => {
    const store = new InMemoryStore();
    const { gate, executed } = makeGate(store, { mode: "assisted" });
    const outcome = await gate({ draft_ref: "draft-1" });
    expect(outcome.status).toBe("awaiting_approval");
    expect(executed).toHaveLength(0);
    const record = await getApprovalForRun(store, "RUN-1");
    expect(record?.status).toBe("pending");
    // Repeated calls (the injection scenario) still refuse to execute.
    const again = await gate({ draft_ref: "draft-1" });
    expect(again.status).toBe("awaiting_approval");
    expect(executed).toHaveLength(0);
  });

  it("executes only after a human approval decision", async () => {
    const store = new InMemoryStore();
    const { gate, executed } = makeGate(store, { mode: "assisted" });
    const pending = await gate({ draft_ref: "draft-1" });
    if (pending.status !== "awaiting_approval")
      throw new Error("expected pause");
    await decideApproval(store, pending.approval_id, {
      actor: "visitor:anon-1",
      decision: "approve",
      reason: "looks right",
    });
    const outcome = await gate({ draft_ref: "draft-1" });
    expect(outcome.status).toBe("executed");
    expect(executed).toEqual([false]);
  });

  it("a rejection never executes and reports the reason", async () => {
    const store = new InMemoryStore();
    const { gate, executed } = makeGate(store, { mode: "assisted" });
    const pending = await gate({ draft_ref: "draft-1" });
    if (pending.status !== "awaiting_approval")
      throw new Error("expected pause");
    await decideApproval(store, pending.approval_id, {
      actor: "visitor:anon-1",
      decision: "reject",
      reason: "wrong GL code",
    });
    const outcome = await gate({ draft_ref: "draft-1" });
    expect(outcome.status).toBe("approval_rejected");
    expect(outcome.status === "approval_rejected" && outcome.reason).toBe(
      "wrong GL code",
    );
    expect(executed).toHaveLength(0);
  });

  it("autonomous mode executes the clean case without approval", async () => {
    const store = new InMemoryStore();
    const { gate, executed } = makeGate(store, { mode: "autonomous" });
    const outcome = await gate({ draft_ref: "draft-1" });
    expect(outcome.status).toBe("executed");
    expect(executed).toEqual([false]);
  });

  it("autonomous mode still pauses above the hard floor (policy binds the toggle)", async () => {
    const store = new InMemoryStore();
    const { gate, executed } = makeGate(store, {
      mode: "autonomous",
      totalCents: 580_000,
      guardrailBlocks: [checkFloor(580_000)],
    });
    const outcome = await gate({ draft_ref: "draft-1" });
    expect(outcome.status).toBe("awaiting_approval");
    expect(outcome.status === "awaiting_approval" && outcome.reason).toContain(
      "hard floor",
    );
    expect(executed).toHaveLength(0);
  });

  it("shadow mode executes simulated without touching approvals", async () => {
    const store = new InMemoryStore();
    const { gate, executed } = makeGate(store, { mode: "shadow" });
    const outcome = await gate({ draft_ref: "draft-1" });
    expect(outcome.status).toBe("executed");
    expect(outcome.status === "executed" && outcome.simulated).toBe(true);
    expect(executed).toEqual([true]);
    expect(await getApprovalForRun(store, "RUN-1")).toBeNull();
  });
});

describe("approval records", () => {
  it("decisions are single-shot", async () => {
    const store = new InMemoryStore();
    const record = await createApproval(store, {
      run_id: "RUN-2",
      draft_ref: "draft-2",
      route: "route_for_approval",
    });
    await decideApproval(store, record.approval_id, {
      actor: "script",
      decision: "edit_approve",
      reason: "adjusted pay date",
    });
    await expect(
      decideApproval(store, record.approval_id, {
        actor: "script",
        decision: "reject",
        reason: "no",
      }),
    ).rejects.toThrow(/already decided/);
  });
});
