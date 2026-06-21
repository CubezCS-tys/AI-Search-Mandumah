import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// NOTE: @vitejs/plugin-react (for JSX in component/characterization tests) is
// added in the C0 step. v6 pulls a rolldown native binding that is not present
// in this environment; use @vitejs/plugin-react@^4 when wiring component tests.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
  },
});
