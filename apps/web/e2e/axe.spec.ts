import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, DOC, E2E_ADMIN_KEY } from "./constants";
import {
  approvalIdFromUrl,
  openPendingApproval,
  resetDemo,
  submitIntake,
} from "./helpers";

// Spec 12 §4: axe gate on all routes, zero WCAG 2.2 A/AA violations, with
// REAL data present (an executed run, a populated trace, a pending
// approval, ERP rows) - an empty demo would pass vacuously.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag22aa"];

async function scan(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target.join(" ")),
  }));
  expect(summary, `axe WCAG 2.2 A/AA violations on ${label}`).toEqual([]);
}

test.describe("@axe accessibility gate", () => {
  let executedRunId = "";
  let pendingApprovalId = "";

  // Real data first: an executed run (ERP rows + a full trace) and a run
  // parked at the approval gate.
  test.beforeAll(async ({ browser }) => {
    await resetDemo();
    const context = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();
    executedRunId = await submitIntake(page, {
      item: DOC.corvidaMonthly,
      mode: "autonomous",
    });
    await expect(page.locator("span.outcome-executed")).toBeVisible();
    await submitIntake(page, { item: DOC.peloraCleaning, mode: "assisted" });
    await openPendingApproval(page);
    pendingApprovalId = approvalIdFromUrl(page);
    await context.close();
  });

  test("@axe landing and intake (/)", async ({ page }) => {
    await page.goto("/");
    await scan(page, "/");
  });

  test("@axe run index (/runs)", async ({ page }) => {
    await page.goto("/runs");
    await scan(page, "/runs");
  });

  test("@axe populated run detail (/runs/[id])", async ({ page }) => {
    await page.goto(`/runs/${executedRunId}`);
    await expect(page.getByRole("heading", { name: /^Run/ })).toBeVisible();
    // Scan with every trace <details> expanded: collapsed content is not
    // reachable, and the expanded state is what an approver actually reads.
    await page
      .locator("details.event")
      .evaluateAll((nodes) =>
        nodes.forEach((node) => ((node as HTMLDetailsElement).open = true)),
      );
    await scan(page, `/runs/${executedRunId}`);
  });

  test("@axe eval report (/eval)", async ({ page }) => {
    await page.goto("/eval");
    // Scan with the caveat/drill-down <details> expanded: collapsed content
    // is not reachable by the scanner.
    await page
      .locator("details")
      .evaluateAll((nodes) =>
        nodes.forEach((node) => ((node as HTMLDetailsElement).open = true)),
      );
    await scan(page, "/eval");
  });

  test("@axe memory tables (/memory)", async ({ page }) => {
    await page.goto("/memory");
    await scan(page, "/memory");
  });

  test("@axe mock ERP (/backend)", async ({ page }) => {
    await page.goto("/backend");
    await expect(page.locator("tr.row-agent").first()).toBeVisible();
    await scan(page, "/backend");
  });

  test("@axe populated approval screen (/approvals/[id])", async ({ page }) => {
    await page.goto(`/approvals/${pendingApprovalId}`);
    await expect(page.getByRole("heading", { name: /Evidence/ })).toBeVisible();
    await scan(page, `/approvals/${pendingApprovalId}`);
  });

  // /admin is a route handler, but it returns a full HTML document, so it is
  // in scope for the gate like any other page; it just needs Basic auth.
  test("@axe admin panel (/admin)", async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: BASE_URL,
      httpCredentials: { username: "admin", password: E2E_ADMIN_KEY },
    });
    const page = await context.newPage();
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "Backoffice admin" }),
    ).toBeVisible();
    await scan(page, "/admin");
    await context.close();
  });
});
