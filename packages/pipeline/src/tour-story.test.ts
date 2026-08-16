// The guided tour (LOT-118) narrates a specific disposition in business
// language at beat 4: "even in Autonomous mode this invoice stops and asks a
// person". That copy is only honest while INB-005 actually parks, so the
// claim is pinned here rather than left to prose.
//
// A verification pass found the `route_for_approval` label asserted only in
// the INV-* eval namespace, never for the INB-* demo inbox document the tour
// actually drives. This closes that gap.

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "@novagait/agent";
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
  it("INB-005 in autonomous mode parks for a human, and says so by route", async () => {
    const result = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-005",
      mode: "autonomous",
    });
    expect(result.outcome).toBe("awaiting_approval");
    expect(result.route).toBe("route_for_approval");
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
