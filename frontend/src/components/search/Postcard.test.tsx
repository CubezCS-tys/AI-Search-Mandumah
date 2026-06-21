import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Postcard } from "./Postcard";
import { searchFixture } from "@/mocks/fixtures";

const withMarc = searchFixture.results[0]; // authors/year/journal present
const nullMarc = searchFixture.results[2]; // authors/year/journal null (MARC-absent doc)

describe("Postcard", () => {
  it("renders the wordmark, title, quote, and footer", () => {
    render(<Postcard item={withMarc} />);
    expect(screen.getByText(withMarc.title)).toBeInTheDocument();
    expect(screen.getByText(/al-manzuma/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp("«"))).toBeInTheDocument();
  });

  it("shows the author line when MARC authors exist", () => {
    render(<Postcard item={withMarc} />);
    expect(screen.getByText(/العتيبي/)).toBeInTheDocument();
  });

  it("degrades gracefully when MARC fields are null (no author line)", () => {
    render(<Postcard item={nullMarc} />);
    expect(screen.getByText(nullMarc.title)).toBeInTheDocument();
    expect(screen.queryByText(/العتيبي/)).toBeNull();
    // still shows the journal_id fallback in the footer doc id
    expect(screen.getByText(new RegExp(nullMarc.doc_id))).toBeInTheDocument();
  });

  it("renders the burgundy variant without crashing", () => {
    render(<Postcard item={withMarc} variant="burgundy" />);
    expect(screen.getByText(withMarc.title)).toBeInTheDocument();
  });
});
