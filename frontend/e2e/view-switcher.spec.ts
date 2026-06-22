import { test, expect } from "@playwright/test";

// The results-view switcher (Normal / Score Reactor / Postcards). Driven by the
// MSW search fixture so results exist and the switcher renders. Buttons are found
// by their aria-label (stable on mobile where the text label is icon-only).

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.use.colorScheme === "dark") {
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  }
});

const Q = "/search?q=" + encodeURIComponent("التعلم المقلوب");

test("switches Normal -> Score Reactor -> Postcards -> Normal, mutually exclusive", async ({ page }) => {
  await page.goto(Q);
  const sw = page.getByRole("group", { name: "طريقة العرض" });
  await expect(sw).toBeVisible();

  // force: the sticky search bar overlays Playwright's auto-scrolled click point on
  // the small mobile viewport (a geometry artifact, not a real obstruction). The
  // button is resolved correctly by aria-label; we assert the resulting navigation.
  const tap = (name: string) => sw.getByRole("button", { name }).click({ force: true });

  // -> Score Reactor
  await tap("مفاعل الترتيب");
  await expect(page).toHaveURL(/lab=1/);
  await expect(page).not.toHaveURL(/cards=1/);
  await expect(page.locator(".font-heading", { hasText: "مفاعل الترتيب" })).toBeVisible();

  // -> Postcards (lab must be cleared)
  await tap("البطاقات");
  await expect(page).toHaveURL(/cards=1/);
  await expect(page).not.toHaveURL(/lab=1/);
  await expect(page.locator(".font-heading", { hasText: "بطاقات المنظومة" })).toBeVisible();

  // -> back to Normal (neither flag)
  await tap("النتائج");
  await expect(page).not.toHaveURL(/lab=1/);
  await expect(page).not.toHaveURL(/cards=1/);
});

test("view switcher visual baseline", async ({ page }) => {
  await page.goto(Q);
  const sw = page.getByRole("group", { name: "طريقة العرض" });
  await expect(sw).toBeVisible();
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await expect(sw).toHaveScreenshot("view-switcher.png");
});
