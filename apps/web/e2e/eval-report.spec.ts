import { expect, test } from "@playwright/test";

// Spec 12 §4, beat 8: "eval report renders from committed JSON" (LOT-109).
// The route is static: everything asserted here comes from
// eval-data.generated.ts, compiled out of the committed run artifacts.
test("eval report renders from committed JSON", async ({ page }) => {
  await page.goto("/eval");

  await expect(
    page.getByRole("heading", { level: 1, name: /evaluation/i }),
  ).toBeVisible();

  // Results-as-of banner with the run stamps (model, SDK, dates).
  const banner = page.getByTestId("results-as-of");
  await expect(banner).toContainText("2026-08-13");
  await expect(banner).toContainText("0.115.0");

  // The headline: GRD-004 zeroed on the deployed tier, stamped versions.
  await expect(page.getByTestId("headline-grd004")).toContainText("0");
  await expect(page.getByTestId("before-after")).toContainText("1.2.0");
  await expect(page.getByTestId("before-after")).toContainText("1.3.0");

  // Full published matrix: all six lanes present with cost-per-correct.
  const matrix = page.getByTestId("published-matrix");
  await expect(matrix.getByRole("row")).toHaveCount(7); // header + 6 lanes
  await expect(matrix).toContainText("claude-opus-5");

  // Honest reporting: the gate board is not green and says so.
  await expect(page.getByTestId("go-no-go")).toContainText(/no-go/i);

  // Judge calibration is published with its agreement figure.
  await expect(page.getByTestId("calibration")).toContainText("7/12");

  // Per-case drill-down exists and names a real failing case.
  await expect(page.getByTestId("drill-down")).toContainText("INV-021");
});
