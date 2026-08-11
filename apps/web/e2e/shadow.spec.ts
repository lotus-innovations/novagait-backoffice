import { expect, test } from "@playwright/test";
import { DOC } from "./constants";
import {
  expectRunOutcome,
  openTraceText,
  resetDemo,
  submitIntake,
} from "./helpers";

// Spec 12 §4, beat 2: a shadow run exercises the whole path and touches
// nothing in the ERP.
test.describe("shadow run touches nothing", () => {
  test.beforeAll(async () => resetDemo());

  test("shadow mode executes the same code path with writes marked simulated", async ({
    page,
  }) => {
    const runId = await submitIntake(page, {
      item: DOC.brightlineSupplies,
      mode: "shadow",
    });
    await expectRunOutcome(page, "executed");

    const trace = await openTraceText(page);
    expect(trace).toContain("backend.write");
    expect(trace).toContain('"simulated": true');
    expect(trace).not.toContain('"simulated": false');

    await page.goto("/backend");
    // Nothing scheduled, and no ledger row attributed to any run.
    await expect(page.getByText("Nothing scheduled.")).toBeVisible();
    await expect(page.locator("tr.row-agent")).toHaveCount(0);
    await expect(page.getByRole("link", { name: runId.slice(-8) })).toHaveCount(
      0,
    );
  });
});
