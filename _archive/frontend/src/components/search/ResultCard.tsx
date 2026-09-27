"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { FileText } from "lucide-react";
import type { SearchResultItem } from "@/types/search";
import { getSectionColor } from "@/lib/utils";
import ScoreBar from "./ScoreBar";
import HighlightText from "./HighlightText";

interface ResultCardProps {
  result: SearchResultItem;
  index: number;
  query?: string;
  maxScore?: number;
}

export default function ResultCard({ result, index, query = "", maxScore }: ResultCardProps) {
  const href = `/document/${result.doc_id}?q=${encodeURIComponent(query)}`;

  return (
    <Link href={href} className="block">
      <motion.article
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.3,
          delay: index * 0.04,
          ease: [0.25, 0.46, 0.45, 0.94],
        }}
        className="group cursor-pointer rounded-xl border border-border-subtle bg-bg-elevated px-5 py-4 transition-all duration-150 hover:border-border hover:shadow-sm"
      >
        {/* Top row: index number + title + section badge */}
        <div className="mb-2 flex items-start gap-2.5">
          <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-bg-primary border border-border-subtle text-[10px] font-medium text-text-muted" aria-label={`نتيجة ${index + 1}`}>
            {index + 1}
          </span>
          <h3 className="flex-1 font-arabic text-[15px] font-semibold leading-relaxed text-text-primary line-clamp-2">
            {result.title}
          </h3>
          {result.section && (
            <span
              className={`inline-flex flex-shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-medium font-arabic ${getSectionColor(result.section)}`}
            >
              {result.section.replace(/_/g, " ")}
            </span>
          )}
        </div>

        {/* Snippet */}
        {result.text && (
          <p className="mb-3 font-arabic text-[12.5px] leading-relaxed text-text-muted line-clamp-2">
            <HighlightText text={result.text} query={query} />
          </p>
        )}

        {/* Bottom row: metadata + score */}
        <div className="flex items-center gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
            <span className="flex items-center gap-1" dir="ltr">
              <FileText size={11} />
              {result.doc_id}
            </span>
          </div>
          <div className="flex-1 min-w-[120px] max-w-[200px] ms-auto">
            <ScoreBar score={result.score} maxScore={maxScore} />
          </div>
        </div>
      </motion.article>
    </Link>
  );
}
