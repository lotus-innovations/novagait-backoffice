// Integration proof across the real LOT-120 seam. Key-free: the case chosen
// here is rejected by the pre-model GR-SCOPE screen, so the whole path from
// openLiveRun through the graded view runs without a model and without spend.
//
// This is the test that would catch a disposition-parity drift between the
// live surface and the graders, which is the failure mode that would quietly
// invalidate a published matrix.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grade } from "../grade";
import { loadGoldenCases } from "../golden";
import { createMatrixPipeline, modelRouteFrom } from "./live-pipeline";

const GOLDEN_DIR = join(new URL("../../../golden", import.meta.url).pathname);

/** Out-of-scope newsletter: GR-SCOPE blocks it before any model turn. */
const SHORT_CIRCUIT_CASE = "INV-015";

describe("createMatrixPipeline against the live surface", () => {
  it("short-circuits a GR-SCOPE case without ever needing a model", async () => {
    const cases = await loadGoldenCases(GOLDEN_DIR);
    const goldenCase = cases.find((entry) => entry.id === SHORT_CIRCUIT_CASE);
    expect(goldenCase).toBeDefined();

    const { pipeline } = createMatrixPipeline({
      goldenById: new Map(cases.map((entry) => [entry.id, entry] as const)),
    });
    const session = await pipeline.openCase(goldenCase!, {
      mode: "autonomous",
      model: "claude-haiku-4-5",
    });

    expect(session.shortCircuit).toBe(true);

    // The driver's contract for a short-circuited case: start() and finish()
    // are no-ops, and the run is already traced.
    await session.start();
    await session.finish({
      totals: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      iterations: 0,
    });

    const outcome = await session.toOutcome();
    expect(outcome.case_id).toBe(SHORT_CIRCUIT_CASE);
    expect(outcome.decision).toBe("reject");
    expect(outcome.guardrails_fired).toContain("GR-SCOPE");
    // A reject has no invoice to validate, so the schema check is satisfied
    // rather than failed (the same rule cassettes/record.ts applies).
    expect(outcome.output_schema_valid).toBe(true);

    // The real proof: the graders accept it. If the live lane's trace shape
    // drifted from the mock lane's, this is where it would show up.
    const graded = grade(goldenCase!, outcome);
    expect(graded.pass).toBe(true);
    expect(graded.taxonomy.primary).toBeNull();
  });

  it("gives each case its own store so ledger state cannot leak between runs", async () => {
    const cases = await loadGoldenCases(GOLDEN_DIR);
    const byId = new Map(cases.map((entry) => [entry.id, entry] as const));
    const { pipeline } = createMatrixPipeline({ goldenById: byId });
    const goldenCase = byId.get(SHORT_CIRCUIT_CASE)!;

    const first = await pipeline.openCase(goldenCase, {
      mode: "autonomous",
      model: "claude-haiku-4-5",
    });
    const second = await pipeline.openCase(goldenCase, {
      mode: "autonomous",
      model: "claude-haiku-4-5",
    });

    expect(first.store).not.toBe(second.store);
    expect(first.runId).not.toBe(second.runId);
  });
});

describe("modelRouteFrom", () => {
  const draft = (seq: number, route: string | null) =>
    ({
      seq,
      type: "tool.call",
      name: "draft_action",
      args: { route: "exception_hold", model_route: route },
    }) as never;

  it("reads the model's proposal off the last draft_action", () => {
    expect(
      modelRouteFrom([
        draft(1, "auto_approve"),
        { seq: 2, type: "tool.call", name: "kb_search", args: {} } as never,
        draft(3, "route_for_approval"),
      ]),
    ).toBe("route_for_approval");
  });

  it("is null when the run never drafted or the field is absent", () => {
    expect(modelRouteFrom([])).toBeNull();
    expect(modelRouteFrom([draft(1, null)])).toBeNull();
  });
});
