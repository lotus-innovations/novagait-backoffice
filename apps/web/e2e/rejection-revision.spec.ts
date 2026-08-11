import { expect, test } from "@playwright/test";
import { DOC } from "./constants";
import {
  expectRunOutcome,
  openPendingApproval,
  resetDemo,
  submitIntake,
} from "./helpers";

// Spec 12 §4, beat 3: reject with a reason, get exactly one revision, then
// the second rejection ends the run held (MAX_REVISIONS = 1).
test.describe("rejection plus one revision cycle", () => {
  test.beforeAll(async () => resetDemo());

  test("first rejection revises the draft, second rejection holds the run", async ({
    page,
  }) => {
    const runId = await submitIntake(page, {
      item: DOC.peloraCleaning,
      mode: "assisted",
    });
    await expectRunOutcome(page, "awaiting_approval");

    const firstApproval = await openPendingApproval(page);
    const firstDraft = await page
      .getByRole("row", { name: /Draft/ })
      .locator("code")
      .last()
      .innerText();
    await page
      .getByLabel("Rejection reason (required)")
      .fill("wrong PO, hold for review");
    await page.getByRole("button", { name: "Reject" }).click();

    // Back on the run, parked again on a NEW approval against a -R1 draft.
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
    await expectRunOutcome(page, "awaiting_approval");
    const secondApproval = await openPendingApproval(page);
    expect(secondApproval).not.toBe(firstApproval);
    await expect(
      page.getByRole("row", { name: /Draft/ }).locator("code").last(),
    ).toHaveText(`${firstDraft}-R1`);

    await page
      .getByLabel("Rejection reason (required)")
      .fill("still wrong, do not pay");
    await page.getByRole("button", { name: "Reject" }).click();

    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
    await expectRunOutcome(page, "held");

    // The revision cap is visible in memory: one revision, then terminal.
    await page.goto("/memory");
    await expect(
      page
        .locator("section[aria-labelledby='run-state-h']")
        .getByRole("row", { name: new RegExp(runId.slice(-8)) }),
    ).toContainText("held");
  });
});
