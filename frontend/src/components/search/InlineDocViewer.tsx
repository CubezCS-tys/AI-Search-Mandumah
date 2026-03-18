"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Loader2 } from "lucide-react";

interface InlineDocViewerProps {
  docId: string;
  maxPages?: number;
}

/**
 * Scrollable page-image viewer — renders all pages in a vertical scroll container
 * with zoomed-out thumbnails so users can browse the full document.
 */
export default function InlineDocViewer({
  docId,
  maxPages = 80,
}: InlineDocViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [lastValid, setLastValid] = useState(maxPages);
  const [currentPage, setCurrentPage] = useState(1);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Track which page is visible via IntersectionObserver
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const p = Number((entry.target as HTMLElement).dataset.page);
            if (p) setCurrentPage(p);
          }
        }
      },
      { root: container, threshold: 0.5 }
    );

    // Observe after a tick so refs are populated
    const timer = setTimeout(() => {
      pageRefs.current.forEach((el) => observer.observe(el));
    }, 100);

    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [docId, lastValid]);

  const handleError = useCallback(
    (page: number) => {
      // First page that fails → that's where the doc ends
      setLastValid((prev) => Math.min(prev, page - 1));
    },
    []
  );

  const pages = Array.from({ length: lastValid }, (_, i) => i + 1);

  return (
    <div className="flex flex-col rounded-xl border border-border-subtle bg-white overflow-hidden flex-1 min-h-0">
      {/* Scrollable page stack */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto bg-gray-100 p-2 space-y-2"
      >
        {pages.map((p) => (
          <PageThumb
            key={`${docId}-${p}`}
            docId={docId}
            page={p}
            onError={handleError}
            ref={(el) => {
              if (el) pageRefs.current.set(p, el);
              else pageRefs.current.delete(p);
            }}
          />
        ))}
      </div>

      {/* Compact page indicator */}
      <div className="flex items-center justify-center border-t border-border-subtle px-3 py-1 bg-white">
        <span className="text-[10px] tabular-nums text-text-muted" dir="ltr">
          {currentPage} / {lastValid}
        </span>
      </div>
    </div>
  );
}

/* ── single page thumbnail ── */
import React from "react";

const PageThumb = React.forwardRef<
  HTMLDivElement,
  { docId: string; page: number; onError: (p: number) => void }
>(function PageThumb({ docId, page, onError }, ref) {
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  if (errored) return null;

  return (
    <div
      ref={ref}
      data-page={page}
      className="relative rounded-lg overflow-hidden bg-white shadow-sm"
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-gray-50">
          <Loader2 size={14} className="animate-spin text-rose-300" />
        </div>
      )}
      <img
        src={`/api/document/${docId}/page/${page}/image`}
        alt={`Page ${page}`}
        loading="lazy"
        className={`w-full h-auto transition-opacity duration-200 ${loading ? "opacity-0" : "opacity-100"}`}
        onLoad={() => setLoading(false)}
        onError={() => {
          setLoading(false);
          setErrored(true);
          onError(page);
        }}
        draggable={false}
      />
    </div>
  );
});
