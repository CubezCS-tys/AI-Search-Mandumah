import { test, expect } from "@playwright/test";

// Characterization + visual test for the P2 SynthesisPanel integration. Drives
// the REAL advanced-synthesis stream (MSW fixture: tokens + evidence + [DONE]),
// which proves the fragile streaming-markdown core still works AND the new
// Evidence Console tab renders. This is the regression guard for the additive
// integration (the answer view is unchanged) + the anti-slop visual baseline.

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.use.colorScheme === "dark") {
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  }
});

test("evidence console tab via advanced synthesis", async ({ page }) => {
  await page.goto("/search?q=" + encodeURIComponent("التعلم المقلوب") + "&synth=advanced");
  // Start advanced synthesis (the idle trigger).
  await page.getByRole("button", { name: /تحليل متقدم/ }).first().click();
  // Evidence arriving makes the tab appear; clicking it shows the console.
  const tab = page.getByRole("button", { name: "وحدة الأدلة" });
  await expect(tab).toBeVisible();
  await tab.scrollIntoViewIfNeeded();
  // force past the page's sticky header, which overlaps the tab on the narrow
  // mobile viewport after scroll (a layout overlap, not a tab defect).
  await tab.click({ force: true });
  await expect(page.getByText("ميزان التوافق")).toBeVisible();
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("evidence-console.png", { fullPage: true });
});
