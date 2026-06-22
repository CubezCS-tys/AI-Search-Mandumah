import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ViewSwitcher } from "./ViewSwitcher";

describe("ViewSwitcher", () => {
  it("renders the three view segments", () => {
    render(<ViewSwitcher current="normal" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "النتائج" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "مفاعل الترتيب" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "البطاقات" })).toBeInTheDocument();
  });

  it("marks the current view as pressed and the others not", () => {
    render(<ViewSwitcher current="lab" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "مفاعل الترتيب" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "النتائج" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "البطاقات" })).toHaveAttribute("aria-pressed", "false");
  });

  it("fires onChange with the clicked view value", () => {
    const onChange = vi.fn();
    render(<ViewSwitcher current="normal" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "البطاقات" }));
    expect(onChange).toHaveBeenCalledWith("cards");
    fireEvent.click(screen.getByRole("button", { name: "مفاعل الترتيب" }));
    expect(onChange).toHaveBeenCalledWith("lab");
  });
});
