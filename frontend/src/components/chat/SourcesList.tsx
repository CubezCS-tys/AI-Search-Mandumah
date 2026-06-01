"use client";

import Link from "next/link";
import { useState } from "react";
import { FileText, ChevronDown, ChevronUp } from "lucide-react";
import type { Source } from "@/types/chat";

interface SourcesListProps {
  sources: Source[];
  /** Original user question, forwarded to the viewer for highlighting. */
  query?: string;
}

export default function SourcesList({ sources, query }: SourcesListProps) {
  const [open, setOpen] = useState(false);

  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-3 border-t border-border-subtle pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[12px] font-arabic font-medium text-text-muted transition-colors hover:text-accent"
      >
        <FileText size={13} />
        <span>المصادر ({sources.length})</span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>

      {open && (
        <ul className="mt-2.5 space-y-2">
          {sources.map((s, i) => {
            const href = query
              ? `/document/${encodeURIComponent(s.doc_id)}?q=${encodeURIComponent(query)}`
              : `/document/${encodeURIComponent(s.doc_id)}`;
            return (
              <li key={`${s.chunk_id}-${i}`}>
                <Link
                  href={href}
                  className="group block rounded-xl border border-border bg-bg-elevated px-3 py-2.5 transition-all hover:border-accent/40 hover:shadow-sm"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent/[0.08] text-[10px] font-bold text-accent">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-arabic text-[12.5px] font-semibold text-text-primary group-hover:text-accent">
                        {s.title || s.doc_id}
                      </p>
                      {s.snippet && (
                        <p className="mt-0.5 line-clamp-2 font-arabic text-[11.5px] leading-relaxed text-text-muted">
                          {s.snippet}
                        </p>
                      )}
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-text-muted">
                        {s.section && <span className="truncate">{s.section}</span>}
                        {typeof s.score === "number" && (
                          <span className="shrink-0 rounded bg-bg-primary px-1.5 py-0.5 font-mono">
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
