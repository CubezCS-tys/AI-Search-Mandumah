import { describe, it, expect } from "vitest";
import { buildSearchUrl, type SearchUrlState } from "./searchUrl";

const base: SearchUrlState = {
  q: "تعلم",
  mode: "hybrid",
  synth: "standard",
  hyde: false,
  journalId: "",
  section: "",
  docId: "",
  lab: false,
  cards: false,
};

describe("buildSearchUrl", () => {
  it("always carries q/mode/synth", () => {
    const u = buildSearchUrl(base);
    expect(u.startsWith("/search?")).toBe(true);
    const p = new URLSearchParams(u.split("?")[1]);
    expect(p.get("q")).toBe("تعلم");
    expect(p.get("mode")).toBe("hybrid");
    expect(p.get("synth")).toBe("standard");
  });

  it("adds hyde + filters only when set", () => {
    const p = new URLSearchParams(
      buildSearchUrl({ ...base, hyde: true, journalId: "0201", section: "المقدمة", docId: "d1" }).split("?")[1],
    );
    expect(p.get("hyde")).toBe("1");
    expect(p.get("journal")).toBe("0201");
    expect(p.get("section")).toBe("المقدمة");
    expect(p.get("doc")).toBe("d1");
  });

  it("normal view sets neither lab nor cards", () => {
    const p = new URLSearchParams(buildSearchUrl(base).split("?")[1]);
    expect(p.get("lab")).toBeNull();
    expect(p.get("cards")).toBeNull();
  });

  it("lab view sets lab=1 and omits cards", () => {
    const p = new URLSearchParams(buildSearchUrl({ ...base, lab: true }).split("?")[1]);
    expect(p.get("lab")).toBe("1");
    expect(p.get("cards")).toBeNull();
  });

  it("cards view sets cards=1 and omits lab", () => {
    const p = new URLSearchParams(buildSearchUrl({ ...base, cards: true }).split("?")[1]);
    expect(p.get("cards")).toBe("1");
    expect(p.get("lab")).toBeNull();
  });

  it("mutual exclusion: both true keeps only lab", () => {
    const p = new URLSearchParams(buildSearchUrl({ ...base, lab: true, cards: true }).split("?")[1]);
    expect(p.get("lab")).toBe("1");
    expect(p.get("cards")).toBeNull();
  });
});
