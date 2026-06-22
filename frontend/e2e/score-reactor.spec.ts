import { test, expect } from "@playwright/test";

// Score Reactor lab mode (PLAN-02), driven by the MSW search fixture (which
// carries the score breakdown). Deterministic: the search Header is the compact
// variant (no canvas), framer-motion layout animations are disabled by the
// config, and the default 50/30/20 weights render a stable initial state.

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.use.colorScheme === "dark") {
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  }
});

test("score reactor lab mode visual baseline", async ({ page }) => {
  await page.goto("/search?q=" + encodeURIComponent("التعلم المقلوب") + "&lab=1");
  // target the ScoreReactor heading (font-heading), not the switcher pill of the same text
  await expect(page.locator(".font-heading", { hasText: "مفاعل الترتيب" })).toBeVisible();
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("score-reactor.png", { fullPage: true });
});
