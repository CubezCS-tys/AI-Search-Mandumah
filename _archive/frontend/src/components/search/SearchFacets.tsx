"use client";

import { useMemo } from "react";
import { getSectionColor } from "@/lib/utils";
import type { SearchResultItem } from "@/types/search";

interface SearchFacetsProps {
  results: SearchResultItem[];
  filters: { journalId: string; section: string; docId: string };
  onChange: (filters: { journalId: string; section: string; docId: string }) => void;
}

interface Facet {
  value: string;
  count: number;
}

/** Tally a field across results into descending-count facets. */
function tally(results: SearchResultItem[], field: "section" | "journal_id"): Facet[] {
  const counts = new Map<string, number>();
  for (const r of results) {
    const v = (r[field] || "").trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Faceted filter chips derived from the current result set. Clicking a chip
 * toggles the matching filter param (re-running the search), so counts reflect
 * the results the user currently sees.
 */
export default function SearchFacets({ results, filters, onChange }: SearchFacetsProps) {
  const sectionFacets = useMemo(() => tally(results, "section"), [results]);
  const journalFacets = useMemo(() => tally(results, "journal_id"), [results]);

  if (sectionFacets.length === 0 && journalFacets.length === 0) return null;

  return (
    <div className="mb-5 flex flex-col gap-2.5">
      {sectionFacets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-arabic text-[11px] font-medium text-text-muted">
            الأقسام:
          </span>
          {sectionFacets.map((f) => {
            const active = filters.section === f.value;
            return (
              <button
                key={f.value}
                onClick={() =>
                  onChange({ ...filters, section: active ? "" : f.value })
                }
                aria-pressed={active}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-arabic text-[11px] font-medium transition ${
                  active
                    ? "bg-accent text-white"
                    : `${getSectionColor(f.value)} hover:opacity-80`
                }`}
              >
                <span>{f.value.replace(/_/g, " ")}</span>
                <span className="tabular-nums opacity-70" dir="ltr">
                  {f.count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {journalFacets.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-arabic text-[11px] font-medium text-text-muted">
            المجلات:
          </span>
          {journalFacets.map((f) => {
            const active = filters.journalId === f.value;
            return (
              <button
                key={f.value}
                onClick={() =>
                  onChange({ ...filters, journalId: active ? "" : f.value })
                }
                aria-pressed={active}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                  active
                    ? "border-accent bg-accent text-white"
                    : "border-border-subtle bg-bg-elevated text-text-muted hover:border-accent/40 hover:text-accent"
                }`}
                dir="ltr"
              >
                <span>{f.value}</span>
                <span className="tabular-nums opacity-70">{f.count}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
