import { describe, it, expect } from "vitest";
import { consensus, deriveSignals, qualityWeight } from "./signals";
import { synthesisEvidence } from "@/mocks/sse";
import type { EvidenceDoc } from "@/types/search";

const doc = (i: number, p: Partial<EvidenceDoc>): EvidenceDoc => ({
  doc_index: i,
  doc_id: "d" + i,
  ...p,
});

describe("consensus (quality-weighted)", () => {
  it("weights by evidence_quality and reports a verdict + counts", () => {
    const c = consensus(synthesisEvidence as EvidenceDoc[]);
    expect(c.total).toBe(3);
    expect(c.counts.support).toBe(1);
    expect(c.counts.contrast).toBe(1);
    expect(c.weighted.support).toBeCloseTo(1.0); // عالية
    expect(c.weighted.contrast).toBeCloseTo(0.6); // متوسطة
    expect(c.verdict).toContain("توافق جزئي");
  });
  it("qualityWeight maps known labels and defaults the rest", () => {
    expect(qualityWeight("عالية")).toBe(1.0);
    expect(qualityWeight("medium")).toBe(0.6);
    expect(qualityWeight("???")).toBe(0.6);
  });
  it("empty evidence yields a 'no sources' verdict", () => {
    expect(consensus([]).verdict).toContain("لا مصادر");
  });
});

describe("deriveSignals", () => {
  it("returns nothing for empty evidence (never hallucinates)", () => {
    expect(deriveSignals([])).toEqual([]);
  });

  it("flags a contested finding citing both sides, and every signal cites >=1 doc", () => {
    const signals = deriveSignals(synthesisEvidence as EvidenceDoc[]);
    const contested = signals.find((s) => s.type === "contested");
    expect(contested).toBeTruthy();
    expect(contested!.docIndices.sort()).toEqual([1, 2, 3]);
    for (const s of signals) expect(s.docIndices.length).toBeGreaterThan(0);
  });

  it("surfaces forward directions from the (dropped) implications with a quote", () => {
    const fwd = deriveSignals(synthesisEvidence as EvidenceDoc[]).find(
      (s) => s.type === "forward-direction",
    );
    expect(fwd).toBeTruthy();
    expect(fwd!.quote).toBeTruthy();
  });

  it("clusters a recurring limitation across >=2 docs by token overlap", () => {
    const ev = [
      doc(1, { stance: "support", limitations: ["العيّنة محدودة الحجم في هذه الدراسة"] }),
      doc(2, { stance: "support", limitations: ["العيّنة محدودة الحجم في الدراسة الحالية"] }),
    ];
    const sig = deriveSignals(ev).find((s) => s.type === "recurring-limitation");
    expect(sig).toBeTruthy();
    expect(sig!.docIndices.sort()).toEqual([1, 2]);
  });

  it("flags methodological monoculture when one method dominates", () => {
    const ev = [
      doc(1, { methodology: "وصفي ارتباطي" }),
      doc(2, { methodology: "وصفي ارتباطي" }),
      doc(3, { methodology: "وصفي ارتباطي" }),
    ];
    const sig = deriveSignals(ev).find((s) => s.type === "methodological-monoculture");
    expect(sig).toBeTruthy();
    expect(sig!.docIndices.length).toBe(3);
  });
});
