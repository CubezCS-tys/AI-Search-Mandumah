import { describe, it, expect } from "vitest";
import { looksLikeMetadata, displayTitle, canonicalSection, sectionColor } from "./display";

describe("looksLikeMetadata (real VPS title cases)", () => {
  it("flags author/affiliation/DOI/journal-metadata lines + empty", () => {
    expect(looksLikeMetadata("أ. فاطمة عبد الواحد معرفي")).toBe(true);
    expect(looksLikeMetadata("أ .نوال عائض آل مشافي جامعة الملك خالد - السعودية")).toBe(true);
    expect(looksLikeMetadata("المجلد 8 العدد 4/ ديسمبر 2024/ ص ص 186 - 206 DOI : 10.58205/fber")).toBe(true);
    // Journal/org names used as titles (seen live in the v2 corpus).
    expect(looksLikeMetadata("Arab Journal for Humanities and Social Sciences")).toBe(true);
    expect(looksLikeMetadata("MANSOURA UNIVERSITY")).toBe(true);
    expect(looksLikeMetadata("الجمعية المصرية لتكنولوجيا التعليم")).toBe(true);
    expect(looksLikeMetadata("المجلة العربية للتربية")).toBe(true);
    expect(looksLikeMetadata("")).toBe(true);
    expect(looksLikeMetadata(null)).toBe(true);
  });
  it("accepts genuine titles", () => {
    expect(looksLikeMetadata("البنية السردية المزدوجة في رواية شرق المتوسط لعبد الرحمن منيف")).toBe(false);
    expect(looksLikeMetadata("دور هيئات الضمان الاجتماعي وشركات التأمين في تقديم نظم الحماية")).toBe(false);
  });
});

describe("displayTitle", () => {
  it("returns a genuine title with isReal=true", () => {
    expect(displayTitle({ title: "البنية السردية المزدوجة", doc_id: "x" })).toEqual({
      text: "البنية السردية المزدوجة",
      isReal: true,
    });
  });
  it("falls back to the doc_id for an empty title", () => {
    expect(displayTitle({ title: "", doc_id: "2142-005-001-001" })).toEqual({
      text: "2142-005-001-001",
      isReal: false,
    });
  });
  it("keeps a metadata title as text but flags isReal=false", () => {
    const r = displayTitle({ title: "أ. فاطمة معرفي", doc_id: "x" });
    expect(r.isReal).toBe(false);
    expect(r.text).toBe("أ. فاطمة معرفي");
  });
});

describe("canonicalSection (messy real values)", () => {
  it("folds variants into the canonical 7", () => {
    expect(canonicalSection("مقدمة")).toBe("المقدمة");
    expect(canonicalSection("Abstract")).toBe("المستخلص");
    expect(canonicalSection("الدراسات السابقة")).toBe("الإطار النظري");
    expect(canonicalSection("Conclusion")).toBe("الخاتمة");
  });
  it("maps empty/unknown to أخرى", () => {
    expect(canonicalSection("")).toBe("أخرى");
    expect(canonicalSection("المبحث الثاني")).toBe("أخرى");
    expect(canonicalSection("5. قائمة المراجع")).toBe("أخرى");
  });
  it("sectionColor returns a colour for every input", () => {
    expect(sectionColor("النتائج")).toMatch(/^#/);
    expect(sectionColor("")).toMatch(/^#/);
  });
});
