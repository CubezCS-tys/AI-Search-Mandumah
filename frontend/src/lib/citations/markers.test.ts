import { describe, it, expect } from "vitest";
import {
  addNumberedCitationLinks,
  citedNumbers,
  slugify,
  splitQuotedCitations,
  isQuotedCitation,
  unwrapCitation,
  mergeQuotedCitations,
} from "./markers";

describe("addNumberedCitationLinks", () => {
  it("turns (م N) into a markdown anchor link", () => {
    expect(addNumberedCitationLinks("نص (م 3) هنا")).toContain("[م3](#cite-3)");
  });
});

describe("citedNumbers", () => {
  it("collects the distinct cited source numbers", () => {
    expect([...citedNumbers("(م 1) ثم (م 3) ثم (م 1)")].sort((a, b) => a - b)).toEqual([1, 3]);
  });
});

describe("slugify", () => {
  it("builds a stable syn- prefixed slug", () => {
    expect(slugify("Hello   World")).toBe("syn-Hello-World");
  });
});

describe("quoted citation helpers", () => {
  it("splits text isolating the «...» span", () => {
    expect(splitQuotedCitations("a «x» b")).toEqual(["a ", "«x»", " b"]);
  });
  it("detects and unwraps a quoted citation", () => {
    expect(isQuotedCitation("«x»")).toBe(true);
    expect(isQuotedCitation("x")).toBe(false);
    expect(unwrapCitation("«x»")).toBe("x");
  });
});

describe("mergeQuotedCitations", () => {
  it("merges «a» <connector> «b» into a single citation", () => {
    const merged = mergeQuotedCitations(splitQuotedCitations("«أ» و «ب»"));
    const cites = merged.filter(isQuotedCitation);
    expect(cites).toHaveLength(1);
    expect(cites[0]).toBe("«أ و ب»");
  });
  it("leaves non-adjacent citations untouched", () => {
    const merged = mergeQuotedCitations(splitQuotedCitations("«أ» نص طويل جدا «ب»"));
    expect(merged.filter(isQuotedCitation)).toHaveLength(2);
  });
});
