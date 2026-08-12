// Pins the tracing contract from the eval side, where getting it wrong shows
// up as a wrong graded decision rather than a wrong log line.
//
// History worth keeping: my adapter once mirrored the wrapper and computed
// `traceArgs` BEFORE the executor. On draft_action the projector then had no
// disposed route to read and fell back to the model's raw proposal, so every
// graded `decision` would have been what the model asked for rather than what
// policy allowed, GRD hard-zero would have fired on correctly-disposed runs,
// and the divergence column would have read zero for all 73 cases.
//
// 8a8b904 made that structural: the projector reads the disposed route from
// the executor's OWN result, so there is nothing to read if a caller projects
// too early. These tests run against the product's exported `traceToolCalls`,
// so they guard the real path rather than a copy of it.

import { describe, expect, it } from "vitest";
import { traceToolCalls, type LiveRun } from "@novagait/pipeline";

interface Appended {
  name: string;
  args: Record<string, unknown>;
}

type FakeRun = Pick<
  LiveRun,
  "executors" | "writer" | "traceArgs" | "shortCircuit"
>;

/**
 * A LiveRun stand-in whose projector mirrors the product's: the disposed
 * route comes from the executor's result, and the model's proposal stays on
 * the side as `model_route`.
 */
function fakeRun(
  appended: Appended[],
  options: { failDraft?: boolean; shortCircuit?: boolean } = {},
): FakeRun {
  return {
    shortCircuit: options.shortCircuit
      ? ({ outcome: "rejected", route: "reject" } as never)
      : null,
    executors: {
      draft_action: async () => {
        if (options.failDraft) throw new Error("executor failed");
        // The disposition is decided inside the executor and reported in its
        // result, which is the only place the projector can read it from.
        return JSON.stringify({
          draft_ref: "DRAFT-1",
          route: "exception_hold",
        });
      },
      lookup_vendor: async () => JSON.stringify({ resolved: true }),
    } as unknown as LiveRun["executors"],
    traceArgs: ((
      name: string,
      input: Record<string, unknown>,
      output: string | undefined,
    ) => {
      if (name !== "draft_action") return input;
      let disposed: string | undefined;
      try {
        disposed = (JSON.parse(output ?? "{}") as { route?: string }).route;
      } catch {
        disposed = undefined;
      }
      return {
        route: disposed ?? input.route,
        model_route: input.route,
      };
    }) as unknown as LiveRun["traceArgs"],
    writer: {
      append: async (event: {
        name: string;
        args: Record<string, unknown>;
      }) => {
        appended.push({ name: event.name, args: event.args });
      },
    } as unknown as LiveRun["writer"],
  };
}

describe("traceToolCalls contract (product wrapper)", () => {
  it("traces the DISPOSED route, not the model's proposal", async () => {
    const appended: Appended[] = [];
    const executors = traceToolCalls(fakeRun(appended), () => 0);

    await executors.draft_action({ route: "auto_approve" } as never);

    const traced = appended.find((entry) => entry.name === "draft_action");
    // Policy said hold, the model said approve, and the graded decision is
    // read from this field.
    expect(traced?.args.route).toBe("exception_hold");
    // The proposal survives alongside it, which is what makes the divergence
    // column possible at all.
    expect(traced?.args.model_route).toBe("auto_approve");
    expect(traced?.args.route).not.toBe(traced?.args.model_route);
  });

  it("still traces when the executor throws", async () => {
    const appended: Appended[] = [];
    const executors = traceToolCalls(
      fakeRun(appended, { failDraft: true }),
      () => 0,
    );

    await expect(
      executors.draft_action({ route: "auto_approve" } as never),
    ).rejects.toThrow("executor failed");

    // No result to project from on this path, so the proposal is all there
    // is; what matters is that the call is still recorded.
    expect(appended).toHaveLength(1);
    expect(appended[0].args.model_route).toBe("auto_approve");
  });

  it("refuses to trace a short-circuited run, so nothing lands after run.end", async () => {
    const appended: Appended[] = [];
    const executors = traceToolCalls(
      fakeRun(appended, { shortCircuit: true }),
      () => 0,
    );

    await executors.lookup_vendor({ name_raw: "Corvida" } as never);

    // A GR-SCOPE run's trace is closed. A tool.call appended after run.end
    // would appear in the graded tool_calls of a run that never called a
    // model, which is the property this guards.
    expect(appended).toHaveLength(0);
  });

  it("passes non-draft tools through untouched", async () => {
    const appended: Appended[] = [];
    const executors = traceToolCalls(fakeRun(appended), () => 0);

    await executors.lookup_vendor({ name_raw: "Corvida" } as never);

    expect(appended[0].args).toEqual({ name_raw: "Corvida" });
  });
});
