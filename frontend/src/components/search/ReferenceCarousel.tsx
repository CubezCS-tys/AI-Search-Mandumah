"use client";

import { useCallback } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ExternalLink, FileText } from "lucide-react";
import type { SearchResultItem } from "@/types/search";
import { getSectionColor } from "@/lib/utils";
import HighlightText from "./HighlightText";

interface ReferenceCarouselProps {
  results: SearchResultItem[];
  activeIndex: number;
  onSelect: (index: number) => void;
  query?: string;
}

const STACK_DEPTH = 4;

export default function ReferenceCarousel({
  results,
  activeIndex,
  onSelect,
  query = "",
}: ReferenceCarouselProps) {
  const total = results.length;

  const goNext = useCallback(
    () => onSelect((activeIndex + 1) % total),
    [activeIndex, total, onSelect]
  );
  const goPrev = useCallback(
    () => onSelect((activeIndex - 1 + total) % total),
    [activeIndex, total, onSelect]
  );

  // Fill stack: active card at pos 0, cards behind at pos 1, 2, 3…
  const stackCards = Array.from({ length: Math.min(STACK_DEPTH, total) }, (_, i) => ({
    result: results[(activeIndex + i) % total],
    globalIndex: (activeIndex + i) % total,
    stackPos: i,
  }));

  // Render back-to-front so active card sits on top in the DOM
  const renderOrder = [...stackCards].reverse();

  return (
    <div className="sticky top-[105px] flex flex-col gap-4">
      {/* 3D card stack */}
      <div className="relative h-[460px] select-none">
        {renderOrder.map(({ result, globalIndex, stackPos }) => {
          const isActive = stackPos === 0;
          const xOff  = stackPos * 18;
          const yOff  = stackPos * 11;
          const scale = 1 - stackPos * 0.055;
          const opacity = 1 - stackPos * 0.26;
          const brightness = 1 - stackPos * 0.13;

          return (
            <motion.div
              key={result.chunk_id}
              animate={{ x: xOff, y: yOff, scale, opacity }}
              transition={{ type: "spring", stiffness: 280, damping: 28 }}
              style={{
                position: "absolute",
                inset: 0,
                zIndex: STACK_DEPTH - stackPos,
                filter: `brightness(${brightness})`,
                cursor: isActive ? "default" : "pointer",
              }}
              onClick={!isActive ? () => onSelect(globalIndex) : undefined}
              className="overflow-hidden rounded-2xl border border-border bg-bg-elevated shadow-md"
            >
              <CardFace
                result={result}
                index={globalIndex}
                query={query}
                isActive={isActive}
              />
            </motion.div>
          );
        })}
      </div>

      {/* Navigation row */}
      <div className="flex items-center justify-between px-1">
        <button
          onClick={goPrev}
          disabled={total <= 1}
          aria-label="المرجع السابق"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-bg-elevated text-text-muted transition hover:text-text-primary disabled:opacity-30"
        >
          <ChevronRight size={15} />
        </button>

        <div className="flex items-center gap-1.5">
          {Array.from({ length: Math.min(total, 12) }).map((_, i) => (
            <button
              key={i}
              onClick={() => onSelect(i)}
              aria-label={`المرجع ${i + 1}`}
              aria-current={i === activeIndex}
              className={`rounded-full transition-all ${
                i === activeIndex
                  ? "h-2 w-5 bg-rose-500"
                  : "h-2 w-2 bg-border hover:bg-text-muted"
              }`}
            />
          ))}
          {total > 12 && (
            <span className="ms-1 text-[10px] tabular-nums text-text-muted">
              {activeIndex + 1}/{total}
            </span>
          )}
        </div>

        <button
          onClick={goNext}
          disabled={total <= 1}
          aria-label="المرجع التالي"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-bg-elevated text-text-muted transition hover:text-text-primary disabled:opacity-30"
        >
          <ChevronLeft size={15} />
        </button>
      </div>
    </div>
  );
}

interface CardFaceProps {
  result: SearchResultItem;
  index: number;
  query: string;
  isActive: boolean;
}

function CardFace({ result, index, query, isActive }: CardFaceProps) {
  const href = `/document/${result.doc_id}?q=${encodeURIComponent(query)}`;

  return (
    <div className="flex h-full flex-col p-6" dir="rtl">
      {/* Index badge + section + score */}
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-rose-600 text-[11px] font-bold text-white">
          {index + 1}
        </span>
        {result.section && (
          <span
            className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium font-arabic ${getSectionColor(result.section)}`}
          >
            {result.section.replace(/_/g, " ")}
          </span>
        )}
        <span className="ms-auto font-mono text-[12px] font-semibold text-rose-600" dir="ltr">
          {result.score.toFixed(1)}
        </span>
      </div>

      {/* Title */}
      <h3 className="mb-3 font-arabic text-[15px] font-bold leading-relaxed text-text-primary line-clamp-2">
        {result.title}
      </h3>

      {/* Excerpt — more lines on active card */}
      <p
        className={`flex-1 overflow-hidden font-arabic text-[13px] leading-relaxed text-text-secondary ${
          isActive ? "line-clamp-6" : "line-clamp-3"
        }`}
      >
        <HighlightText text={result.text} query={query} />
      </p>

      {/* Footer */}
      <div className="mt-4 border-t border-border-subtle pt-3">
        <div className="mb-2.5 flex items-center gap-1.5 text-[11px] text-text-muted">
          <FileText size={11} />
          <span dir="ltr">{result.doc_id}</span>
        </div>
        {isActive && (
          <Link
            href={href}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-rose-600 px-3 py-2.5 text-[13px] font-arabic font-semibold text-white transition hover:bg-rose-700 active:scale-95"
          >
            <ExternalLink size={13} />
            فتح المستند
          </Link>
        )}
      </div>
    </div>
  );
}
