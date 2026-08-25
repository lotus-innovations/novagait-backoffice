// The pill's copy is the whole finding here (LOT-118 audit, finding 5): the
// approval redirect used to accuse the visitor of leaving the tour at the
// exact moment they followed it. Both branches are pinned.

import { describe, expect, it } from "vitest";
import { resumePillCopy } from "./resume-copy";
import { APPROVAL_HANDOFF_STEP_ID, TOUR_STEPS } from "./steps";

const erpStep = TOUR_STEPS.find((s) => s.id === APPROVAL_HANDOFF_STEP_ID);
const memoryStep = TOUR_STEPS.find((s) => s.id === "memory");

describe("off-script pill copy", () => {
  it("reads as progress when an approval lands the visitor on the run page", () => {
    const copy = resumePillCopy(erpStep, "/runs/01JABCDEF");
    expect(copy.message).toBe("Approved. The action executed.");
    expect(copy.linkLabel).toBe("Next: see it land in the books");
    // The destination itself still comes from the step table, not the copy.
    expect(erpStep?.route).toBe("/backend");
  });

  it("stays generic for a genuine detour to the same pending beat", () => {
    const copy = resumePillCopy(erpStep, "/eval");
    expect(copy.message).toContain("stepped off the tour path");
    expect(copy.linkLabel).toBe(`Continue the tour: ${erpStep?.title}`);
  });

  it("stays generic on the run page when the pending beat is not the handoff", () => {
    const copy = resumePillCopy(memoryStep, "/runs/01JABCDEF");
    expect(copy.message).toContain("stepped off the tour path");
    expect(copy.linkLabel).toBe(`Continue the tour: ${memoryStep?.title}`);
  });

  it("drops the link when no reachable beat remains", () => {
    const copy = resumePillCopy(undefined, "/runs/01JABCDEF");
    expect(copy.message).toContain("stepped off the tour path");
    expect(copy.linkLabel).toBeNull();
  });
});
