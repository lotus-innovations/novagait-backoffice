import { test } from "@playwright/test";

// Spec 12 §4, beat 8: "eval report renders from committed JSON".
// The /eval route is LOT-109 and does not exist yet; this spec is the
// placeholder that lane fills in. Do not un-fixme it before /eval ships.
test.fixme("eval report renders from committed JSON (LOT-109: /eval route not built yet)", async ({
  page,
}) => {
  await page.goto("/eval");
});
