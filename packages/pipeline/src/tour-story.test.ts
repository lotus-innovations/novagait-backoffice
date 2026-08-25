// The guided tour (LOT-118) narrates a specific disposition in business
// language at beat 4: "even in Autonomous mode this invoice stops and asks a
// person". That copy is only honest while INB-003 actually parks, and parks
// for the reason beat 4 gives (a price that differs slightly from the order,
// inside the allowed range but not zero), so both the route and the reason
// are pinned here rather than left to prose.
//
// A verification pass found the `route_for_approval` label asserted only in
// the INV-* eval namespace, never for the INB-* demo inbox document the tour
// actually drives. This closes that gap.

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore, RunStateMachine } from "@novagait/agent";
import { MockBackend } from "@novagait/mock-backend";
import { runMockPipeline } from "./mock-agent";

let store: InMemoryStore;
let backend: MockBackend;

beforeEach(async () => {
  store = new InMemoryStore();
  backend = new MockBackend(store);
  await backend.seed();
});

describe("guided tour story spine", () => {
  it("INB-003 in autonomous mode parks for a human, and says so by route", async () => {
    const result = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-003",
      mode: "autonomous",
    });
    expect(result.outcome).toBe("awaiting_approval");
    expect(result.route).toBe("route_for_approval");

    // The route alone would still pass if someone swapped in an invoice that
    // parks over the autonomy cap, a duplicate, or an unresolved vendor, and
    // beat 4's copy would then describe a disposition the demo never reaches.
    // Pin the reason: a price variance that is nonzero but inside tolerance.
    const machine = await RunStateMachine.load(store, result.runId);
    const match = machine.state.data.match as {
      exceptions: string[];
      minor_exceptions: string[];
      variance_cents?: number;
    };
    expect(match.exceptions).toEqual([]);
    expect(match.minor_exceptions).toEqual(["price_variance_within_tolerance"]);
    expect(match.variance_cents).toBeGreaterThan(0);
    expect(String(machine.state.data.policy_line)).toContain(
      "minor exception: price_variance_within_tolerance",
    );
  });

  it("the contrast case still executes, so beat 4 is a real distinction", async () => {
    // If everything parked, "it knows when not to act" would be vacuous.
    const result = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-001",
      mode: "autonomous",
    });
    expect(result.outcome).toBe("executed");
    expect(result.route).toBe("auto_approve");
  });
});
