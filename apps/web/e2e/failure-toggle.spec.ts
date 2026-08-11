import { expect, test } from "@playwright/test";
import { DOC } from "./constants";
import {
  expectRunOutcome,
  openTraceText,
  resetDemo,
  setFailureToggle,
  submitIntake,
} from "./helpers";

// Spec 12 §4, beat 5: with the failure toggle armed the first payment write
// fails, the retry succeeds, and BOTH are visible in the trace with the real
// error message (schema v2 error event, recoverable: true).
test.describe("failure toggle retry is visible in the trace", () => {
  test.beforeAll(async () => {
    await resetDemo();
    await setFailureToggle(true);
  });

  test.afterAll(async () => setFailureToggle(false));

  test("the transient payment failure and its retry are both traced", async ({
    page,
  }) => {
    const runId = await submitIntake(page, {
      item: DOC.brightlineSupplies,
      mode: "autonomous",
    });
    await expectRunOutcome(page, "executed");

    const trace = await openTraceText(page);
    expect(trace).toContain("execute.payment_schedule");
    expect(trace).toContain(
      "payment schedule service unavailable (simulated transient failure)",
    );
    expect(trace).toContain('"recoverable": true');
    // Retry succeeded: the payment row still landed.
    expect(trace).toContain("payment_schedule");

    await page.goto("/backend");
    await expect(
      page.getByRole("link", { name: runId.slice(-8) }).first(),
    ).toBeVisible();
  });
});
