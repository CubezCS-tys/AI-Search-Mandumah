import { test, expect } from "@playwright/test";

// Proves the visual harness end to end: the MSW-enabled dev server runs, the
// page renders, fonts load, the .dark theme applies per project, and a
// deterministic screenshot baseline holds across all projects. /admin/login is
// fully static (no canvas/animation), so it is a stable first baseline; feature
// pages add their own specs as they are built.

test.beforeEach(async ({ page }, testInfo) => {
  // The app's dark mode is a .dark class driven by localStorage (not just the OS
  // colour-scheme), so seed it before the pre-paint script runs for dark projects.
  if (testInfo.project.use.colorScheme === "dark") {
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  }
});

test("admin login visual baseline", async ({ page }) => {
  await page.goto("/admin/login");
  await expect(page.getByText("Vector Console")).toBeVisible();
  // Hide the Next dev-tools overlay so it never pollutes the baseline.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("admin-login.png", { fullPage: true });
});
