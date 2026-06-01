"use client";

import { motion } from "framer-motion";

interface ScoreBarProps {
  score: number;
  /** The highest score in the result set — used to normalize the bar width. */
  maxScore?: number;
}

export default function ScoreBar({ score, maxScore }: ScoreBarProps) {
  // Normalize relative to best result so bars are visually meaningful
  const top = maxScore && maxScore > 0 ? maxScore : score;
  const normalizedPct = Math.min((score / top) * 100, 100);
  const rawPct = (score * 100).toFixed(1);

  return (
    <div
      className="flex items-center gap-2.5"
      role="meter"
      aria-valuenow={Number(rawPct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`درجة الصلة ${rawPct}%`}
    >
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-border-subtle/70">
        <motion.div
          className="h-full rounded-full"
          style={{
            background:
              normalizedPct > 80
                ? "linear-gradient(90deg, #9B1B30, #c62a40)"
                : normalizedPct > 50
                ? "linear-gradient(90deg, #d4636f, #e8949c)"
                : "linear-gradient(90deg, #b0b0c0, #c8c8d4)",
          }}
          initial={{ width: 0 }}
          animate={{ width: `${normalizedPct}%` }}
          transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
        />
      </div>
      <span className="min-w-[2.5rem] text-end text-[11px] tabular-nums text-text-muted" dir="ltr">
        {rawPct}
      </span>
    </div>
  );
}
