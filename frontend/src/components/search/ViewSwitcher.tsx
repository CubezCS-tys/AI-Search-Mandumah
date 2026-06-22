"use client";

import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { List, SlidersHorizontal, LayoutGrid } from "lucide-react";

export type SearchView = "normal" | "lab" | "cards";

// Segmented control to switch the results view between the normal list, the Score
// Reactor (lab), and the Postcards gallery. The active background slides between
// segments via a shared layoutId (same pattern as SearchBar mode pills); the
// MotionProvider at the app root disables that transform under reduced-motion.
const VIEWS: { value: SearchView; label: string; icon: ReactNode }[] = [
  { value: "normal", label: "النتائج", icon: <List size={13} /> },
  { value: "lab", label: "مفاعل الترتيب", icon: <SlidersHorizontal size={13} /> },
  { value: "cards", label: "البطاقات", icon: <LayoutGrid size={13} /> },
];

export function ViewSwitcher({
  current,
  onChange,
}: {
  current: SearchView;
  onChange: (view: SearchView) => void;
}) {
  return (
    <div
      role="group"
      aria-label="طريقة العرض"
      className="flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-bg-elevated/90 p-0.5"
    >
      {VIEWS.map((v) => {
        const active = current === v.value;
        return (
          <button
            key={v.value}
            type="button"
            onClick={() => onChange(v.value)}
            aria-pressed={active}
            aria-label={v.label}
            className="relative rounded-full px-3 py-1.5 text-[12px] transition-colors"
          >
            {active && (
              <motion.div
                layoutId="view-switcher-pill"
                className="absolute inset-0 rounded-full bg-accent/[0.10]"
                transition={{ type: "spring", stiffness: 500, damping: 35 }}
              />
            )}
            <span
              className={`relative z-10 flex items-center gap-1.5 font-medium ${
                active ? "text-accent" : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {v.icon}
              <span className="font-arabic hidden sm:inline">{v.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
