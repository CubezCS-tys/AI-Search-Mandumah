import { test, expect } from "@playwright/test";

// Postcards gallery (PLAN-05) over the MSW search fixture. Deterministic: static
// cards (no animation), so a stable baseline. Verifies the shareable cards render
// (incl. the MARC-null degradation on hit 3) across the project matrix.

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.use.colorScheme === "dark") {
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  }
});

test("postcards gallery visual baseline", async ({ page }) => {
  await page.goto("/search?q=" + encodeURIComponent("التعلم المقلوب") + "&cards=1");
  await expect(page.getByText("بطاقات المنظومة")).toBeVisible();
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("postcards.png", { fullPage: true });
});
