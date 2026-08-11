import { expect, request, type Page } from "@playwright/test";
import { BASE_URL, E2E_ADMIN_KEY, E2E_CRON_SECRET } from "./constants";

export type RunMode = "shadow" | "assisted" | "autonomous";

/**
 * Restore seed state (runs, traces, approvals, vendor profiles, dedupe
 * ledger, failure toggle, ERP tables). Every spec file calls this in
 * beforeAll so files are order-independent even though they share one
 * server process and one in-memory store.
 */
export async function resetDemo(): Promise<void> {
  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    const response = await api.post("/api/maintenance/reset", {
      headers: { authorization: `Bearer ${E2E_CRON_SECRET}` },
    });
    expect(response.status(), await response.text()).toBe(200);
  } finally {
    await api.dispose();
  }
}

export async function setFailureToggle(armed: boolean): Promise<void> {
  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    const response = await api.post("/api/admin/failure-toggle", {
      headers: { authorization: `Bearer ${E2E_ADMIN_KEY}` },
      data: { armed },
    });
    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toMatchObject({ armed });
  } finally {
    await api.dispose();
  }
}

/** The run id is the last path segment of /runs/{id}. */
export function runIdFromUrl(page: Page): string {
  const match = /\/runs\/([^/?#]+)/.exec(page.url());
  if (!match) throw new Error(`not on a run page: ${page.url()}`);
  return match[1];
}

export function approvalIdFromUrl(page: Page): string {
  const match = /\/approvals\/([^/?#]+)/.exec(page.url());
  if (!match) throw new Error(`not on an approval page: ${page.url()}`);
  return match[1];
}

/**
 * Drive the real intake form on `/` (the only visitor path into a run) and
 * land on the run page it redirects to.
 */
export async function submitIntake(
  page: Page,
  options: { item: string; mode: RunMode; note?: string; scripted?: boolean },
): Promise<string> {
  await page.goto(options.scripted ? "/?approver=script" : "/");
  await page.locator(`input[name="item"][value="${options.item}"]`).check();
  await page.locator(`input[name="mode"][value="${options.mode}"]`).check();
  if (options.note) {
    await page.getByLabel(/Note to accounts payable/).fill(options.note);
  }
  await page.getByRole("button", { name: "Run the agent" }).click();
  // An intake rejection redirects back to /?error=...; make that loud.
  await expect(page).toHaveURL(/\/runs\/[^/?#]+$/);
  return runIdFromUrl(page);
}

/** Outcome badge on /runs/{id} (class is `outcome-{outcome}`). */
export async function expectRunOutcome(
  page: Page,
  outcome: string,
): Promise<void> {
  await expect(page.locator(`span.outcome-${outcome}`).first()).toBeVisible();
}

/**
 * Full text of the run timeline with every <details> expanded: the trace is
 * the record, so assertions read it as the visitor would after opening the
 * events.
 */
export async function openTraceText(page: Page): Promise<string> {
  await page
    .locator("details.event")
    .evaluateAll((nodes) =>
      nodes.forEach((node) => ((node as HTMLDetailsElement).open = true)),
    );
  return page.locator("main").innerText();
}

/** Follow the "Review and decide" banner from a parked run. */
export async function openPendingApproval(page: Page): Promise<string> {
  await page.getByRole("link", { name: "Review and decide" }).click();
  await expect(page).toHaveURL(/\/approvals\/[^/?#]+$/);
  return approvalIdFromUrl(page);
}
