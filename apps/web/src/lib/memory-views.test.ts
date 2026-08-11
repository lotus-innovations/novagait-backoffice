import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "@novagait/agent";
import { MockBackend } from "@novagait/mock-backend";
import { runMockPipeline } from "@novagait/pipeline";
import {
  listDedupeEntries,
  listRunStates,
  listVendorProfiles,
} from "./memory-views";

let store: InMemoryStore;
let backend: MockBackend;

beforeEach(async () => {
  store = new InMemoryStore();
  backend = new MockBackend(store);
  await backend.seed();
});

describe("memory view helpers", () => {
  it("are empty on a fresh store", async () => {
    expect(await listRunStates(store)).toEqual([]);
    expect(await listVendorProfiles(store)).toEqual([]);
    expect(await listDedupeEntries(store)).toEqual([]);
  });

  it("surface every store after runs, newest run state first", async () => {
    const first = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-001",
      mode: "autonomous",
    });
    const second = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-005",
      mode: "autonomous",
    });

    const states = await listRunStates(store);
    expect(states.map((s) => s.run_id)).toEqual([second.runId, first.runId]);
    // INB-005 is the date-ambiguity fixture: a sentinel invoice date is a
    // minor exception (spec 07 §6, LOT-106 amendment), so even autonomous
    // mode parks it for approval instead of executing.
    expect(states[0].step).toBe("awaiting_approval");

    const profiles = await listVendorProfiles(store);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].vendor_id).toBe("V-001");
    // Only the executed INB-001 run updates the profile; the parked INB-005
    // run writes it after approval, not before (spec 07 §9).
    expect(profiles[0].runs_count).toBe(1);

    const dedupe = await listDedupeEntries(store);
    expect(dedupe.map((d) => d.run_id).sort()).toEqual(
      [first.runId, second.runId].sort(),
    );
    expect(dedupe.every((d) => d.fixture.startsWith("inbox/"))).toBe(true);
    expect(dedupe.every((d) => /^[0-9a-f]{16}$/.test(d.digest))).toBe(true);
  });
});
