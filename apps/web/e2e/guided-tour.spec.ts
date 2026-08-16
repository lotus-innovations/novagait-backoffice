import { expect, test, type Page } from "@playwright/test";
import { DOC } from "./constants";
import {
  expectRunOutcome,
  openPendingApproval,
  resetDemo,
  submitIntake,
} from "./helpers";

// LOT-118 acceptance: "Tour completes end-to-end against the prod build; e2e
// spec covers the full path", plus keyboard access and no change to the app
// when the tour is off.
//
// The ring assertions are not decoration. Two anchors (`vendor-profiles` and
// `evidence-table`) live inside conditionally-rendered blocks that only exist
// once a run has populated them, and `approval-banner` only renders while an
// approval is pending. A card can render perfectly while its anchor is
// missing, so every beat asserts the SPOTLIGHT is visible, which is the only
// assertion that fails when an anchor disappears.

const CARD = ".tour-card";
const RING = ".tour-spotlight";
const RESUME = ".tour-resume";
const REGION = '[aria-label="Guided tour"]';
const CONTROLS = ".tour-controls";

/**
 * Scope control lookups to the card. In dev, Next.js injects its own button
 * named "Next" (the dev-tools launcher); the prod build this suite drives has
 * no such button, but scoping keeps the selector honest either way.
 */
function control(page: Page, name: string) {
  return page.locator(CONTROLS).getByRole("button", { name, exact: true });
}

/** The card is showing this beat, and its anchor really exists on the page. */
async function expectBeat(
  page: Page,
  title: string,
  anchor: string,
): Promise<void> {
  await expect(page.locator(CARD)).toContainText(title);
  // The anchor element itself must be in the DOM...
  await expect(page.locator(`[data-tour="${anchor}"]`)).toBeVisible();
  // ...and the overlay must have drawn a ring for it, with a real rect.
  const ring = page.locator(RING);
  await expect(ring).toBeVisible();
  const box = await ring.boundingBox();
  expect(box, `spotlight rect for ${anchor}`).not.toBeNull();
  expect(box!.width, `spotlight width for ${anchor}`).toBeGreaterThan(0);
  expect(box!.height, `spotlight height for ${anchor}`).toBeGreaterThan(0);
}

async function startTour(page: Page): Promise<void> {
  await page.locator(".tour-launch").click();
  await expect(page.locator(CARD)).toBeVisible();
}

test.describe("guided tour, full 8-beat walk", () => {
  test.beforeAll(async () => resetDemo());

  test("a visitor walks the whole story and the tour survives every navigation", async ({
    page,
  }) => {
    await page.goto("/");

    // Off by default: the tour adds nothing until it is asked for.
    await expect(page.locator(REGION)).toHaveCount(0);
    await expect(page.locator(CARD)).toHaveCount(0);

    // Beat 1.
    await startTour(page);
    await expectBeat(page, "The back office", "intro");

    // Beat 2.
    await control(page, "Next").click();
    await expectBeat(page, "Start a run", "intake-form");

    // The visitor drives the REAL form, exactly as the card instructs. This
    // is a full document navigation, so surviving it proves the sessionStorage
    // resume rather than any in-memory state.
    const runId = await submitIntake(page, {
      item: DOC.corvidaReporting, // INB-005
      mode: "autonomous",
    });

    // Beat 3, resumed on a new document.
    await expectBeat(page, "The work, step by step", "run-timeline");

    // The pivot the demo exists to show: autonomous mode still stopped.
    await expectRunOutcome(page, "awaiting_approval");

    // Beat 4.
    await control(page, "Next").click();
    await expectBeat(page, "Where it stops", "approval-banner");

    // Beat 5, across another real navigation.
    await openPendingApproval(page);
    await expectBeat(page, "Check the reading", "evidence-table");

    // A real approval. It redirects to /runs/{id}, which no later step
    // matches, so the tour must land off-script and offer a way back in.
    await page.getByLabel("Reason (optional)").fill("evidence checks out");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
    await expectRunOutcome(page, "executed");

    const resume = page.locator(RESUME);
    await expect(resume).toBeVisible();
    const resumeLink = resume.getByRole("link");
    await expect(resumeLink).toHaveAttribute("href", "/backend");
    await resumeLink.click();

    // Beat 6. The ledger must actually hold agent-written rows, or the beat
    // is pointing at an empty table and the story is a lie.
    await expect(page).toHaveURL(/\/backend$/);
    await expectBeat(page, "Into the books", "erp-rows");
    await expect(page.locator("tr.row-agent").first()).toBeVisible();

    // Beat 7, reached by the card's own real link.
    await page.locator(`${CARD} a[href="/memory"]`).click();
    await expect(page).toHaveURL(/\/memory$/);
    await expectBeat(page, "What it remembers", "vendor-profiles");

    // Beat 8.
    await page.locator(`${CARD} a[href="/eval"]`).click();
    await expect(page).toHaveURL(/\/eval$/);
    await expectBeat(page, "The proof, and the limits", "eval-headline");

    // Finish clears the tour, and it stays cleared across a reload.
    await control(page, "Finish").click();
    await expect(page.locator(REGION)).toHaveCount(0);
    await page.reload();
    await expect(page.locator(REGION)).toHaveCount(0);
  });
});

test.describe("guided tour containment", () => {
  test.beforeAll(async () => resetDemo());

  test("Escape ends the tour and it does not come back on reload", async ({
    page,
  }) => {
    await page.goto("/");
    await startTour(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(REGION)).toHaveCount(0);
    await page.reload();
    await expect(page.locator(REGION)).toHaveCount(0);
  });

  test("Skip tour ends the tour and it does not come back on reload", async ({
    page,
  }) => {
    await page.goto("/");
    await startTour(page);
    await control(page, "Skip tour").click();
    await expect(page.locator(REGION)).toHaveCount(0);
    await page.reload();
    await expect(page.locator(REGION)).toHaveCount(0);
  });

  test("the tour is reachable and operable by keyboard alone", async ({
    page,
  }) => {
    await page.goto("/");
    await startTour(page);
    await expectBeat(page, "The back office", "intro");

    // Next is a real button in the normal tab order, not a div with a
    // click handler: focusing it and pressing Enter must advance the beat.
    const next = control(page, "Next");
    await next.focus();
    await expect(next).toBeFocused();
    await page.keyboard.press("Enter");
    await expectBeat(page, "Start a run", "intake-form");

    const back = control(page, "Back");
    await back.focus();
    await page.keyboard.press("Enter");
    await expectBeat(page, "The back office", "intro");
  });

  test("a route with no step degrades to the off-script pill, not a crash", async ({
    page,
  }) => {
    await page.goto("/");
    await startTour(page);
    // /runs (the index) carries no tour step at all.
    await page.goto("/runs");
    await expect(page.locator(RESUME)).toBeVisible();
    // Never a literal wildcard in an href.
    await expect(page.locator('a[href*="*"]')).toHaveCount(0);
    // And the page underneath still works.
    await expect(page.getByRole("heading", { name: /Runs/ })).toBeVisible();
  });

  // A route PATTERN matches on shape, not on the record existing, so
  // "/approvals/*" matches a 404. Before this was guarded, the tour narrated
  // "Check the reading - Step 5 of 8" on top of Next's "This page could not be
  // found", and persisted index 0 -> 4, permanently burning beat 4 (the park
  // the whole demo exists to show) for the rest of the session.
  for (const badPath of ["/approvals/bad-id", "/runs/bad-id"]) {
    test(`the tour does not narrate a beat over a 404 (${badPath})`, async ({
      page,
    }) => {
      await page.goto("/");
      await startTour(page);
      await expectBeat(page, "The back office", "intro");

      await page.goto(badPath);

      // No confident card describing content that is not on the page.
      await expect(page.locator(CARD)).toHaveCount(0);
      // The honest fallback instead.
      await expect(page.locator(RESUME)).toBeVisible();

      // And the visitor's place is intact: no beat was silently consumed.
      const stored = await page.evaluate(() =>
        window.sessionStorage.getItem("novagait.tour.v1"),
      );
      expect(JSON.parse(stored ?? "{}")).toMatchObject({
        active: true,
        index: 0,
      });

      // Going back to the start still offers beat 1, not a fast-forward.
      await page.goto("/");
      await expectBeat(page, "The back office", "intro");
    });
  }

  test("a nav click mid-tour does not consume the beats it skipped", async ({
    page,
  }) => {
    await page.goto("/");
    await startTour(page);
    await expectBeat(page, "The back office", "intro");

    // The visitor gets curious and clicks the app's own nav.
    await page.getByRole("link", { name: "Evals" }).click();
    await expect(page).toHaveURL(/\/eval$/);

    // Their place is preserved, so returning resumes at beat 1 rather than
    // stranding them at "Step 8 of 8" with beats 2-7 marked complete.
    await page.goto("/");
    await expectBeat(page, "The back office", "intro");
  });

  // SC 2.4.11 Focus Not Obscured + SC 2.4.3 Focus Order. A fresh-context a11y
  // pass measured the fixed card covering the mode radios its own copy tells
  // the visitor to operate (308 focus-ring pixels with the tour off, 0 with it
  // on), and focus falling to <body> on every step change and every exit.
  // Focus now starts ON the card, so the visitor tabs OUT into the real
  // controls, and ending the tour hands focus back to the launcher.
  test("focus lands on the card each beat and returns to the launcher on exit", async ({
    page,
  }) => {
    await page.goto("/");
    await startTour(page);

    const focusedClass = () =>
      page.evaluate(
        () =>
          document.activeElement?.className ??
          document.activeElement?.tagName ??
          "",
      );

    expect(await focusedClass()).toContain("tour-card");
    // Programmatically focusable only: it must not become an extra tab stop.
    await expect(page.locator(CARD)).toHaveAttribute("tabindex", "-1");

    await control(page, "Next").click();
    await expectBeat(page, "Start a run", "intake-form");
    // Never <body>: the control that was pressed unmounts on this transition.
    expect(await focusedClass()).toContain("tour-card");

    await page.keyboard.press("Escape");
    await expect(page.locator(REGION)).toHaveCount(0);
    expect(await focusedClass()).toContain("tour-launch");
  });

  // SC 1.4.3. The 42% dimmer composited --muted page text down to 3.62:1,
  // under the 4.5:1 minimum, for as long as the tour was open.
  test("muted page text is promoted while the dimmer is on screen", async ({
    page,
  }) => {
    await page.goto("/");
    const before = await page
      .locator("footer.site p")
      .first()
      .evaluate((el) => getComputedStyle(el).color);

    await startTour(page);
    await expect(page.locator("html")).toHaveAttribute("data-tour-active", "");
    const during = await page
      .locator("footer.site p")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(during).not.toBe(before);
    // --ink, which survives the dim at 6.33:1.
    expect(during).toBe("rgb(28, 32, 38)");

    await control(page, "Skip tour").click();
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-tour-active",
      "",
    );
  });

  // The beat-4 dead end: a Next button there stored an index whose wildcard
  // route nothing could reach, so the tour fell through to the resume pill and
  // skipped beat 5, the evidence beat, entirely.
  test("beat 4 hands off to the real approval link rather than skipping beat 5", async ({
    page,
  }) => {
    await page.goto("/");
    await startTour(page);
    await control(page, "Next").click();
    await submitIntake(page, {
      item: DOC.corvidaReporting,
      mode: "autonomous",
    });
    await expectBeat(page, "The work, step by step", "run-timeline");
    await control(page, "Next").click();
    await expectBeat(page, "Where it stops", "approval-banner");

    // No forward button here by design; the visitor uses the page's own link.
    await expect(control(page, "Next")).toHaveCount(0);
    await openPendingApproval(page);
    await expectBeat(page, "Check the reading", "evidence-table");
  });

  test("the real controls under the overlay stay clickable", async ({
    page,
  }) => {
    await page.goto("/");
    await startTour(page);
    // The scrim and ring are pointer-events:none, so the visitor can still
    // drive the real form while the tour is pointing at it. If either one
    // swallowed clicks, this check() would time out.
    await page
      .locator(`input[name="item"][value="${DOC.corvidaReporting}"]`)
      .check();
    await expect(
      page.locator(`input[name="item"][value="${DOC.corvidaReporting}"]`),
    ).toBeChecked();
  });
});

test.describe("tour off changes nothing", () => {
  test.beforeAll(async () => resetDemo());

  test("with the tour off, the surfaces the other specs depend on are intact", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(REGION)).toHaveCount(0);
    await expect(page.locator(RING)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Run the agent" }),
    ).toBeVisible();
    await expect(page.getByLabel(/Note to accounts payable/)).toBeVisible();
    await expect(
      page.locator(`input[name="item"][value="${DOC.corvidaMonthly}"]`),
    ).toBeAttached();
    await expect(
      page.locator('input[name="mode"][value="assisted"]'),
    ).toBeChecked();
  });
});
