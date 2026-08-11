import { expect, test } from "@playwright/test";
import { DOC } from "./constants";
import {
  expectRunOutcome,
  openTraceText,
  resetDemo,
  submitIntake,
} from "./helpers";

// Spec 12 §4, beat 6: resubmitting a processed document is held, citing the
// run that processed it first rather than paying it twice.
test.describe("duplicate resubmission is held with a prior-run pointer", () => {
  test.beforeAll(async () => resetDemo());

  test("the second submission holds and names the first run", async ({
    page,
  }) => {
    const firstRun = await submitIntake(page, {
      item: DOC.corvidaMonthly,
      mode: "autonomous",
    });
    await expectRunOutcome(page, "executed");

    const secondRun = await submitIntake(page, {
      item: DOC.corvidaMonthly,
      mode: "autonomous",
    });
    expect(secondRun).not.toBe(firstRun);
    await expectRunOutcome(page, "held");

    const trace = await openTraceText(page);
    expect(trace).toContain("check_duplicate");
    expect(trace).toContain("prior");
    // The pointer is the first run id, carried in the check_duplicate result.
    expect(trace).toContain(firstRun);
    expect(trace).toContain("GR-DUP");

    // The dedupe ledger is the readable version of the same pointer.
    await page.goto("/memory");
    await expect(
      page.getByRole("row", { name: /corvida-monthly/ }).first(),
    ).toBeVisible();
  });
});
