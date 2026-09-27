import type { SearchMode } from "@/types/search";

/** Truncate text to maxLen, breaking at last space. */
export function truncate(text: string, maxLen: number = 280): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(" ", maxLen);
  return text.slice(0, cut > 0 ? cut : maxLen) + "…";
}

/** Format score as percentage string. */
export function formatScore(score: number): string {
  return `${(score * 100).toFixed(1)}%`;
}

/** Human-readable mode labels. */
export const MODE_LABELS: Record<SearchMode, { en: string; ar: string }> = {
  hybrid: { en: "Hybrid", ar: "هجين" },
  dense: { en: "Semantic", ar: "دلالي" },
  sparse: { en: "Keyword", ar: "كلمات مفتاحية" },
};

/** Section badge colors keyed by common Arabic section names. */
export const SECTION_COLORS: Record<string, string> = {
  المقدمة: "bg-rose-100 text-rose-800",
  الإطار_النظري: "bg-blue-100 text-blue-800",
  منهجية_البحث: "bg-violet-100 text-violet-800",
  النتائج: "bg-amber-100 text-amber-800",
  المناقشة: "bg-orange-100 text-orange-800",
  الخاتمة: "bg-pink-100 text-pink-800",
  التوصيات: "bg-emerald-100 text-emerald-800",
};

export function getSectionColor(section: string): string {
  return SECTION_COLORS[section] || "bg-stone-100 text-stone-700";
}
