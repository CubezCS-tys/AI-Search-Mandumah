"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { FileText, ChevronDown, ChevronUp, Quote } from "lucide-react";
import type { Source } from "@/types/chat";

interface SourcesListProps {
  sources: Source[];
  /** Original user question, forwarded to the viewer for highlighting. */
  query?: string;
  /** Doc_ids that were actually quoted in the answer (undefined while streaming). */
  citedDocIds?: Set<string>;
}

export default function SourcesList({ sources, query, citedDocIds }: SourcesListProps) {
  const [open, setOpen] = useState(false);

  // Show cited sources first, preserving score order within each group.
  const ordered = useMemo(() => {
    if (!citedDocIds || citedDocIds.size === 0) return sources;
    const cited = sources.filter((s) => citedDocIds.has(s.doc_id));
    const rest = sources.filter((s) => !citedDocIds.has(s.doc_id));
    return [...cited, ...rest];
  }, [sources, citedDocIds]);

  const citedCount = citedDocIds?.size ?? 0;

  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-3 border-t border-border-subtle pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[12px] font-arabic font-medium text-text-muted transition-colors hover:text-accent"
      >
        <FileText size={13} />
        <span>المصادر ({sources.length})</span>
        {citedCount > 0 && (
          <span className="rounded-full bg-accent/[0.08] px-1.5 py-px text-[10.5px] font-semibold text-accent">
            {citedCount} مُستشهد به
          </span>
        )}
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>

      {open && (
        <ul className="mt-2.5 space-y-2">
          {ordered.map((s, i) => {
            const cited = citedDocIds?.has(s.doc_id) ?? false;
            const href = query
              ? `/document/${encodeURIComponent(s.doc_id)}?q=${encodeURIComponent(query)}`
              : `/document/${encodeURIComponent(s.doc_id)}`;
            return (
              <li key={`${s.chunk_id}-${i}`}>
                <Link
                  href={href}
                  className={`group block rounded-xl border bg-bg-elevated px-3 py-2.5 transition-all hover:shadow-sm ${
                    cited
                      ? "border-accent/30 hover:border-accent/50"
                      : "border-border hover:border-accent/40"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent/[0.08] text-[10px] font-bold text-accent">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate font-arabic text-[12.5px] font-semibold text-text-primary group-hover:text-accent">
                          {s.title || s.doc_id}
                        </p>
                        {cited && (
                          <span
                            title="استُشهد بهذا المصدر في الإجابة"
                            className="flex shrink-0 items-center gap-0.5 rounded bg-accent/[0.08] px-1 py-px text-[9.5px] font-semibold text-accent"
                          >
                            <Quote size={9} />
                            مُستشهد
                          </span>
                        )}
                      </div>
                      {s.snippet && (
                        <p className="mt-0.5 line-clamp-2 font-arabic text-[11.5px] leading-relaxed text-text-muted">
                          {s.snippet}
                        </p>
                      )}
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-text-muted">
                        {s.section && <span className="truncate">{s.section}</span>}
                        {typeof s.score === "number" && (
                          <span className="shrink-0 rounded bg-bg-primary px-1.5 py-0.5 font-mono" dir="ltr">
                            {s.score.toFixed(2)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
