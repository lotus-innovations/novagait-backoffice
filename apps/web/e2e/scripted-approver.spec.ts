import { expect, test } from "@playwright/test";
import { DOC } from "./constants";
import {
  expectRunOutcome,
  openTraceText,
  resetDemo,
  submitIntake,
} from "./helpers";

// Spec 12 §4, beat 4: ?approver=script is the deterministic approver used by
// the walkthrough video and this suite; it approves the pending gate inline
// and the decision is recorded honestly as actor "script".
test.describe("scripted approver", () => {
  test.beforeAll(async () => resetDemo());

  test("?approver=script decides the gate without a human and says so", async ({
    page,
  }) => {
    await submitIntake(page, {
      item: DOC.corvidaReporting,
      mode: "assisted",
      scripted: true,
    });
    await expectRunOutcome(page, "executed");

    const trace = await openTraceText(page);
    expect(trace).toContain("approval.requested");
    expect(trace).toContain("approval.decided");
    expect(trace).toContain('"actor": "script"');
    expect(trace).toContain("scripted approver");
  });

  test("without the flag the same document parks for a human", async ({
    page,
  }) => {
    await submitIntake(page, {
      item: DOC.brightlineDisputeNote,
      mode: "assisted",
    });
    await expectRunOutcome(page, "awaiting_approval");
  });
});
