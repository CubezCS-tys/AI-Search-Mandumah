import { describe, it, expect } from "vitest";
import {
  denseRange,
  normalizeParts,
  normalizeWeights,
  blend,
  reweight,
  attribution,
  DEFAULT_WEIGHTS,
  type ScoreParts,
} from "./reweight";

describe("normalizeWeights", () => {
  it("normalizes to sum 1", () => {
    const w = normalizeWeights({ dense: 2, lexical: 1, title: 1 });
    expect(w.dense + w.lexical + w.title).toBeCloseTo(1);
    expect(w.dense).toBeCloseTo(0.5);
  });
  it("falls back to thirds when all weights are zero", () => {
    expect(normalizeWeights({ dense: 0, lexical: 0, title: 0 }).dense).toBeCloseTo(1 / 3);
  });
});

describe("normalizeParts", () => {
  const items: ScoreParts[] = [
    { raw_score: 0.016, lexical_score: 0.2, title_score: 0.9 },
    { raw_score: 0.034, lexical_score: 0.8, title_score: 0.1 },
  ];
  it("min-max normalizes the tiny raw_score to 0..1", () => {
    const range = denseRange(items);
    expect(normalizeParts(items[0], range).denseNorm).toBeCloseTo(0); // the min
    expect(normalizeParts(items[1], range).denseNorm).toBeCloseTo(1); // the max
  });
  it("returns 1.0 denseNorm when all raw_scores tie (no divide-by-zero)", () => {
    const tied = [{ raw_score: 0.02 }, { raw_score: 0.02 }];
    expect(normalizeParts(tied[0], denseRange(tied)).denseNorm).toBe(1.0);
  });
});

describe("reweight", () => {
  // A: strong title, weak semantic. B: strong semantic, weak title.
  const items = [
    { id: "A", raw_score: 0.016, lexical_score: 0.2, title_score: 0.95 },
    { id: "B", raw_score: 0.034, lexical_score: 0.3, title_score: 0.1 },
  ];

  it("ranks the title-strong result first when title weight dominates", () => {
    const out = reweight(items, { dense: 0, lexical: 0, title: 1 });
    expect(out[0].item.id).toBe("A");
    expect(out[0].rank).toBe(1);
  });

  it("ranks the semantic-strong result first when dense weight dominates", () => {
    const out = reweight(items, { dense: 1, lexical: 0, title: 0 });
    expect(out[0].item.id).toBe("B");
  });

  it("produces a blended score the visible parts + weights reproduce by hand", () => {
    const out = reweight(items, { dense: 0.5, lexical: 0.5, title: 0 });
    const a = out.find((r) => r.item.id === "A")!;
    // weights normalize to dense 0.5 / lexical 0.5; A denseNorm=0 (min), lexical=0.2
    expect(a.blended).toBeCloseTo(0.5 * 0 + 0.5 * 0.2);
  });
});

describe("attribution", () => {
  it("names the dominant contributing signal", () => {
    const parts = { denseNorm: 0.1, lexical: 0.1, title: 0.95 };
    expect(attribution(parts, { dense: 0.2, lexical: 0.2, title: 0.6 })).toContain("العنوان");
  });
});

describe("DEFAULT_WEIGHTS", () => {
  it("blends with the default 50/30/20 mix", () => {
    const b = blend({ denseNorm: 1, lexical: 1, title: 1 }, DEFAULT_WEIGHTS);
    expect(b).toBeCloseTo(1);
  });
});
