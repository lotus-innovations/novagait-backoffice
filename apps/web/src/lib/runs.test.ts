import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@novagait/agent";
import { MockBackend } from "@novagait/mock-backend";
import { runMockPipeline } from "@novagait/pipeline";
import { formatMicroUsd, getRunTrace, listRecentRuns } from "./runs";

describe("run viewer data helpers", () => {
  it("lists pipeline runs newest first with summaries, and traces read back", async () => {
    const store = new InMemoryStore();
    const backend = new MockBackend(store);
    await backend.seed();

    const first = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-001",
      mode: "autonomous",
    });
    const second = await runMockPipeline({
      store,
      backend,
      inboxItemId: "INB-015",
      mode: "autonomous",
    });

    const runs = await listRecentRuns(store);
    expect(runs).toHaveLength(2);
    expect(runs[0].run_id).toBe(second.runId); // newest first
    expect(runs[1].run_id).toBe(first.runId);
    expect(runs[1].outcome).toBe("executed");
    expect(runs[0].outcome).toBe("rejected");
    expect(runs[1].input_ref).toBe("inbox/2026-08-03-corvida-monthly.md");

    const events = await getRunTrace(store, first.runId);
    expect(events[0].type).toBe("run.start");
    expect(events.at(-1)?.type).toBe("run.end");
  });

  it("formats micro-dollars", () => {
    expect(formatMicroUsd(3000)).toBe("$0.003000");
    expect(formatMicroUsd(null)).toBe("-");
  });
});
