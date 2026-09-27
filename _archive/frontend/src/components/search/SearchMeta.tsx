"use client";

import { motion } from "framer-motion";
import { MODE_LABELS } from "@/lib/utils";
import type { SearchMode } from "@/types/search";

interface SearchMetaProps {
  total: number;
  searchMs: number;
  mode: string;
}

export default function SearchMeta({ total, searchMs, mode }: SearchMetaProps) {
  const modeLabel = MODE_LABELS[mode as SearchMode]?.ar || mode;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-muted"
    >
      <span className="font-arabic">
        <strong className="text-text-primary font-semibold">{total}</strong> نتيجة
      </span>

      <span className="text-border">·</span>

      <span dir="ltr" className="tabular-nums">
        {searchMs < 1000 ? `${searchMs.toFixed(0)}ms` : `${(searchMs / 1000).toFixed(1)}s`}
      </span>

      <span className="text-border">·</span>

      <span className="font-arabic text-accent font-medium">
        {modeLabel}
      </span>
    </motion.div>
  );
}
