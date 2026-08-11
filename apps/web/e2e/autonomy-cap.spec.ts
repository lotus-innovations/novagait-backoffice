import { expect, test } from "@playwright/test";
import { DOC } from "./constants";
import {
  expectRunOutcome,
  openPendingApproval,
  resetDemo,
  submitIntake,
} from "./helpers";

// Spec 12 §4, beat 7: autonomy is blocked above the cap and the reason is
// shown to the visitor, not buried.
test.describe("autonomy blocked above the cap", () => {
  test.beforeAll(async () => resetDemo());

  test("an above-cap invoice in autonomous mode parks with a stated reason", async ({
    page,
  }) => {
    await submitIntake(page, {
      item: DOC.peloraRenovation,
      mode: "autonomous",
    });
    await expectRunOutcome(page, "awaiting_approval");

    await openPendingApproval(page);
    await expect(page.getByText("full match above autonomy cap")).toBeVisible();
    await expect(
      page.getByText("only auto_approve is autonomy-eligible"),
    ).toBeVisible();
    await expect(page.getByRole("row", { name: /Why a human/ })).toBeVisible();
  });
});
