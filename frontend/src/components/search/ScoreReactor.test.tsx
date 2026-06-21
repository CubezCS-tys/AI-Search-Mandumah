import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScoreReactor } from "./ScoreReactor";
import { searchFixture } from "@/mocks/fixtures";

const results = searchFixture.results;
const titleOrder = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

describe("ScoreReactor", () => {
  it("renders the reactor + a card per result with the breakdown", () => {
    render(<ScoreReactor results={results} />);
    expect(screen.getByText("مفاعل الترتيب")).toBeInTheDocument();
    expect(screen.getByText(results[0].title)).toBeInTheDocument();
    expect(titleOrder()).toHaveLength(results.length);
  });

  it("re-ranks the list when a preset changes the weights", async () => {
    const user = userEvent.setup();
    render(<ScoreReactor results={results} />);
    const before = titleOrder();
    await user.click(screen.getByRole("button", { name: "العنوان" }));
    const after = titleOrder();
    // the highest title_score result should now lead
    const maxTitle = results.reduce((a, b) => ((b.title_score ?? 0) > (a.title_score ?? 0) ? b : a));
    expect(after[0]).toBe(maxTitle.title);
    expect(after).not.toEqual(before);
  });

  it("shows an empty state when there are no results", () => {
    render(<ScoreReactor results={[]} />);
    expect(screen.getByText(/لا توجد نتائج/)).toBeInTheDocument();
  });
});
