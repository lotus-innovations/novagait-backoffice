import { expect, test, type Page } from "@playwright/test";
import { DOC } from "./constants";
import {
  expectRunOutcome,
  openPendingApproval,
  resetDemo,
  submitIntake,
} from "./helpers";

// Spec 12 §4, beat 10: full keyboard walk of the approval screen. The
// approver must be able to read the evidence and complete a decision with no
// mouse, with focus always visible.
interface Stop {
  id: string;
  tag: string;
  label: string;
  outlineWidth: string;
  focusVisible: boolean;
}

async function focusedStop(page: Page): Promise<Stop> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element)
      return {
        id: "",
        tag: "",
        label: "",
        outlineWidth: "0px",
        focusVisible: false,
      };
    const style = getComputedStyle(element);
    return {
      id: element.id,
      tag: element.tagName.toLowerCase(),
      label: (element.textContent ?? "").trim().slice(0, 40),
      outlineWidth: style.outlineWidth,
      focusVisible: element.matches(":focus-visible"),
    };
  });
}

test.describe("keyboard walk of the approval screen", () => {
  test.beforeAll(async () => resetDemo());

  test("every decision control is reachable and the decision completes without a mouse", async ({
    page,
  }) => {
    const runId = await submitIntake(page, {
      item: DOC.peloraCleaning,
      mode: "assisted",
    });
    await openPendingApproval(page);

    // Evidence the approver must read before deciding is on the page and in
    // reading order ahead of the decision forms.
    await expect(page.getByRole("heading", { name: /Evidence/ })).toBeVisible();
    await expect(page.locator("q").first()).toBeVisible();
    const order = await page.evaluate(() => {
      const evidence = document.querySelector("#evidence-h");
      const decide = document.querySelector("#decide-h");
      if (!evidence || !decide) return -1;
      return evidence.compareDocumentPosition(decide) &
        Node.DOCUMENT_POSITION_FOLLOWING
        ? 1
        : 0;
    });
    expect(order).toBe(1);

    // Tab from the top of the document through the whole screen.
    await page.evaluate(() => document.body.focus());
    await page.keyboard.press("Tab");
    const stops: Stop[] = [];
    for (let i = 0; i < 40; i += 1) {
      const stop = await focusedStop(page);
      if (stop.tag === "body" || stop.tag === "") break;
      stops.push(stop);
      if (stop.id === "reject-reason") {
        await page.keyboard.press("Tab");
        stops.push(await focusedStop(page));
        break;
      }
      await page.keyboard.press("Tab");
    }

    const ids = stops.map((stop) => stop.id);
    const labels = stops.map((stop) => stop.label);
    // The run pointer in the intro, then all three decision forms.
    expect(labels.join("|")).toContain(runId.slice(-8));
    for (const id of [
      "approve-reason",
      "edit-gl",
      "edit-date",
      "edit-reason",
      "reject-reason",
    ]) {
      expect(ids, `tab order reaches #${id}`).toContain(id);
    }
    for (const submit of ["Approve", "Approve with edits", "Reject"]) {
      expect(labels, `tab order reaches the ${submit} button`).toContain(
        submit,
      );
    }

    // Focus is visible at every keyboard stop: either the app's
    // :focus-visible outline rule matched, or the control carries a non-zero
    // focus outline of its own (Chromium's native date picker).
    for (const stop of stops) {
      expect(
        stop.focusVisible || stop.outlineWidth !== "0px",
        `${stop.id || stop.label} focus indicator (focus-visible=${stop.focusVisible}, outline=${stop.outlineWidth})`,
      ).toBe(true);
    }

    // Complete the decision with the keyboard only.
    await page.locator("#approve-reason").focus();
    await page.keyboard.type("approved from the keyboard");
    await page.keyboard.press("Tab");
    expect((await focusedStop(page)).label).toBe("Approve");
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
    await expectRunOutcome(page, "executed");
  });
});
