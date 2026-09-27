"use client";

import { motion } from "framer-motion";
import { SearchX } from "lucide-react";
import type { SearchResultItem } from "@/types/search";
import ResultCard from "./ResultCard";

interface SearchResultsProps {
  results: SearchResultItem[];
  query: string;
}

export default function SearchResults({ results, query }: SearchResultsProps) {
  const maxScore = results.length > 0 ? results[0].score : 1;

  if (results.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center justify-center py-20 text-center"
      >
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-border-subtle">
          <SearchX size={28} className="text-text-muted" />
        </div>
        <h3 className="mb-2 font-arabic text-lg font-semibold text-text-primary">
          لا توجد نتائج
        </h3>
        <p className="max-w-sm font-arabic text-sm text-text-muted leading-relaxed">
          حاول تغيير كلمات البحث أو تعديل خيارات التصفية للحصول على نتائج أفضل
        </p>
      </motion.div>
    );
  }

  return (
    <div className="space-y-2.5">
      {results.map((result, i) => (
        <ResultCard
          key={result.chunk_id}
          result={result}
          index={i}
          query={query}
          maxScore={maxScore}
        />
      ))}
    </div>
  );
}
