import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MotionProvider } from "./motion";

// Smoke test that proves the JSX/RTL/jest-dom component-testing path works
// (esbuild automatic JSX, no @vitejs/plugin-react needed). The characterization
// tests for the god-components build on this path.
describe("MotionProvider", () => {
  it("renders its children", () => {
    render(
      <MotionProvider>
        <span>محتوى</span>
      </MotionProvider>,
    );
    expect(screen.getByText("محتوى")).toBeInTheDocument();
  });
});
