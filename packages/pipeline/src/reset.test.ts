// Nightly reset (LOT-92): after real runs dirty every store, resetDemo
// restores a first-boot world — no runs, no profiles, no dedupe memory,
// seed rows back, failure toggle disarmed.

import { beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryStore,
  RunStateMachine,
  VendorProfileStore,
  getApprovalForRun,
  readTrace,
  traceKeys,
} from "@novagait/agent";
import { MockBackend } from "@novagait/mock-backend";
import { runMockPipeline } from "./mock-agent";
import { resetDemo } from "./reset";

let store: InMemoryStore;
let backend: MockBackend;

beforeEach(async () => {
  store = new InMemoryStore();
  backend = new MockBackend(store);
  await backend.seed();
});

describe("resetDemo", () => {
  it("clears runs, approvals, profiles, and dedupe; reseeds the backend", async () => {
    // Dirty every surface: an executed run, a parked approval, an armed
    // toggle, and ledger/payment rows.
    const executed = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-001",
      mode: "autonomous",
    });
    const parked = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-005",
      mode: "assisted",
    });
    await backend.setFailureToggle(true);
    expect(await backend.paymentSchedule()).toHaveLength(1);
    expect(await getApprovalForRun(store, parked.runId)).not.toBeNull();

    const summary = await resetDemo(store);
    expect(summary.runs_cleared).toBe(2);
    expect(summary.reseeded).toBe(true);

    // Runs and their state are gone.
    expect(await readTrace(store, executed.runId)).toEqual([]);
    expect(await RunStateMachine.load(store, executed.runId)).toBeNull();
    expect(await getApprovalForRun(store, parked.runId)).toBeNull();
    expect(await store.listRange(traceKeys.recent(), 0, -1)).toEqual([]);

    // Vendor memory is gone.
    expect(await new VendorProfileStore(store).get("V-001")).toBeNull();

    // Backend is back to seed: no payments, inbox items new, toggle off.
    expect(await backend.paymentSchedule()).toHaveLength(0);
    expect((await backend.getInboxItem("INB-001"))?.state).toBe("new");
    expect(await backend.failureToggle()).toEqual({
      armed: false,
      fired: false,
    });

    // Dedupe memory is gone: the same document re-processes as fresh
    // (executes again) instead of being held as a resubmission.
    const rerun = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-001",
      mode: "autonomous",
    });
    expect(rerun.outcome).toBe("executed");
  });

  it("is safe on an empty store", async () => {
    const summary = await resetDemo(new InMemoryStore());
    expect(summary.runs_cleared).toBe(0);
    expect(summary.reseeded).toBe(true);
  });

  it("clears the daily budget counter so a tripped breaker resets", async () => {
    const { recordRunCost, isCapacityMode, DAILY_BUDGET_MICRO_USD } =
      await import("@novagait/agent");
    await recordRunCost(store, DAILY_BUDGET_MICRO_USD);
    expect(await isCapacityMode(store)).toBe(true);
    await resetDemo(store);
    expect(await isCapacityMode(store)).toBe(false);
  });
});
