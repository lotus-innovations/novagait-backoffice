import { expect, test } from "@playwright/test";
import { DOC } from "./constants";
import {
  expectRunOutcome,
  openPendingApproval,
  resetDemo,
  submitIntake,
} from "./helpers";

// Spec 12 §4, beat 1: submit -> extract -> approve -> the ERP row appears.
test.describe("submit, extract, approve, ERP row appears", () => {
  test.beforeAll(async () => resetDemo());

  test("an approved invoice lands in the mock ERP and links back to its run", async ({
    page,
  }) => {
    const runId = await submitIntake(page, {
      item: DOC.corvidaMonthly,
      mode: "assisted",
      note: "This one looked urgent",
    });

    // Parked at the gate: nothing executed yet.
    await expectRunOutcome(page, "awaiting_approval");
    await expect(
      page.getByText("This run is paused at the approval gate."),
    ).toBeVisible();

    await openPendingApproval(page);

    // Extraction evidence, with the verbatim source span per field.
    const evidence = page.getByRole("table").filter({
      has: page.getByRole("columnheader", {
        name: "As printed on the document",
      }),
    });
    await expect(evidence).toBeVisible();
    await expect(
      evidence.getByRole("row", { name: /invoice_number/ }),
    ).toBeVisible();
    await expect(evidence.locator("q").first()).not.toBeEmpty();
    // The intake note rode along and is shown as screened, untrusted input.
    await expect(page.getByText("This one looked urgent")).toBeVisible();

    await page.getByLabel("Reason (optional)").fill("evidence checks out");
    await page.getByRole("button", { name: "Approve", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
    await expectRunOutcome(page, "executed");

    // Closing the loop: highlighted rows in the mock ERP, linked to the run.
    await page.goto("/backend");
    const short = runId.slice(-8);
    const payments = page.locator("tr.row-agent", {
      has: page.getByRole("link", { name: short }),
    });
    await expect(payments).toHaveCount(2); // ledger row + payment row
    await expect(
      page.getByRole("link", { name: short }).first(),
    ).toHaveAttribute("href", `/runs/${runId}`);
  });
});
