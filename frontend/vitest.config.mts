import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// JSX/TSX is transformed by vitest's built-in esbuild using React 19's automatic
// runtime. We deliberately do NOT use @vitejs/plugin-react: v6 pulls a rolldown
// native binding absent here, and mixing vite versions causes esbuild conflicts.
// esbuild's automatic JSX is sufficient for component + characterization tests.
export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
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
