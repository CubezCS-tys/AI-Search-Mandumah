// Real-data display helpers (grounded in the live VPS corpus, see
// .agent/logs/2026-06-21/VPS-EXPLORATION.md). In academic_articles_v2 the
// payload `title` is the chunk's first OCR heading, NOT the document title, so it
// is frequently an author/affiliation/DOI/journal-metadata line; and the `section`
// taxonomy is hundreds of free-form/mixed/empty values, not the clean 7. These
// helpers let features degrade honestly instead of presenting metadata as a title
// or color-coding a rainbow of section strings.

// A "title" that is really author/affiliation/journal/org metadata, not a title.
// Patterns confirmed against the live v2 corpus (where `title` is the chunk's
// first OCR heading). NB: \b only works around ASCII word chars, so no \b after
// Arabic tokens - anchor those with ^ + a trailing space instead.
const META_TITLE_RE =
  /(^أ\s*\.|^د\s*\.|^المجلد|^المجلة\s|^مجلة\s|^الجمعية\s|^جامعة\s|\bDOI\b|\bJournal\b|\bUniversity\b|ص\s*ص\s*\d|^https?:\/\/|^\d{4}-\d{3}-)/i;

export function looksLikeMetadata(title: string | null | undefined): boolean {
  const t = (title ?? "").trim();
  if (!t) return true;
  return META_TITLE_RE.test(t);
}

/** Best display text for a hit's title + whether it is a genuine title.
 *  When the stored title is metadata/empty, callers should de-emphasize it or
 *  add a "ترويسة المقطع" hint rather than presenting it as the document title. */
export function displayTitle(item: { title?: string | null; doc_id: string }): {
  text: string;
  isReal: boolean;
} {
  const t = (item.title ?? "").trim();
  if (t && !looksLikeMetadata(t)) return { text: t, isReal: true };
  return { text: t || item.doc_id, isReal: false };
}

// Canonical research sections (the 7) + colours, with the messy real values
// folded in. Anything unrecognised -> "أخرى".
export const CANONICAL_SECTIONS = [
  "المقدمة",
  "المستخلص",
  "الإطار النظري",
  "منهجية البحث",
  "النتائج",
  "المناقشة",
  "الخاتمة",
  "التوصيات",
  "أخرى",
] as const;
export type CanonicalSection = (typeof CANONICAL_SECTIONS)[number];

const SECTION_CANON: Record<string, CanonicalSection> = {
  المقدمة: "المقدمة",
  مقدمة: "المقدمة",
  "1. مقدمة": "المقدمة",
  Introduction: "المقدمة",
  "تمهيد وتقسيم": "المقدمة",
  "مشكلة البحث": "المقدمة",
  "مشكلة الدراسة": "المقدمة",
  المستخلص: "المستخلص",
  الملخص: "المستخلص",
  "ملخص البحث": "المستخلص",
  Abstract: "المستخلص",
  "الإطار النظري": "الإطار النظري",
  "الدراسات السابقة": "الإطار النظري",
  "منهجية البحث": "منهجية البحث",
  "منهج البحث": "منهجية البحث",
  النتائج: "النتائج",
  المناقشة: "المناقشة",
  الخاتمة: "الخاتمة",
  Conclusion: "الخاتمة",
  التوصيات: "التوصيات",
};

export function canonicalSection(section: string | null | undefined): CanonicalSection {
  const s = (section ?? "").trim();
  if (!s) return "أخرى";
  return SECTION_CANON[s] ?? "أخرى";
}

export const SECTION_COLOR: Record<CanonicalSection, string> = {
  المقدمة: "#b07a3c",
  المستخلص: "#8a6d3b",
  "الإطار النظري": "#3c6e71",
  "منهجية البحث": "#6a5acd",
  النتائج: "#9B1B30",
  المناقشة: "#2a7a4f",
  الخاتمة: "#8a6d3b",
  التوصيات: "#b5466b",
  أخرى: "#9a938b",
};

export function sectionColor(section: string | null | undefined): string {
  return SECTION_COLOR[canonicalSection(section)];
}
