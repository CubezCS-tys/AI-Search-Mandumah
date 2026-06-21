import { defineConfig, devices } from "@playwright/test";

// Visual-regression harness (PLAN-00b D2). The dev server runs with MSW enabled
// so every /api/* call is answered from fixtures (deterministic, zero OpenAI
// cost). Screenshots are blessed across desktop/mobile x light/dark, plus a
// reduced-motion project that verifies the static fallbacks. animations are
// disabled so motion never flakes the diff.
export default defineConfig({
  testDir: "./e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" } },
  use: { baseURL: "http://localhost:3000" },
  webServer: {
    command: "NEXT_PUBLIC_API_MOCKING=enabled npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop-light", use: { ...devices["Desktop Chrome"], colorScheme: "light" } },
    { name: "desktop-dark", use: { ...devices["Desktop Chrome"], colorScheme: "dark" } },
    { name: "mobile-light", use: { ...devices["Pixel 5"], colorScheme: "light" } },
    { name: "mobile-dark", use: { ...devices["Pixel 5"], colorScheme: "dark" } },
    {
      name: "reduced-motion",
      use: { ...devices["Desktop Chrome"], colorScheme: "light", reducedMotion: "reduce" },
    },
  ],
});
