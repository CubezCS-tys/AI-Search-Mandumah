"use client";

import { useState, useRef, useEffect, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Search, Sparkles, TextSearch, Binary } from "lucide-react";
import type { SearchMode } from "@/types/search";

const MODES: { value: SearchMode; label: string; icon: React.ReactNode }[] = [
  { value: "hybrid", label: "هجين", icon: <Sparkles size={14} /> },
  { value: "dense", label: "دلالي", icon: <Search size={14} /> },
  { value: "sparse", label: "كلمات مفتاحية", icon: <TextSearch size={14} /> },
];

interface SearchBarProps {
  /** Pre-filled query (for results page). */
  initialQuery?: string;
  /** Pre-selected mode. */
  initialMode?: SearchMode;
  /** If true, renders the compact top-bar variant. */
  variant?: "hero" | "compact";
  /** Callback instead of navigation (for results page live-search). */
  onSearch?: (query: string, mode: SearchMode) => void;
}

export default function SearchBar({
  initialQuery = "",
  initialMode = "hybrid",
  variant = "hero",
  onSearch,
}: SearchBarProps) {
  const [query, setQuery] = useState(initialQuery);
  const [mode, setMode] = useState<SearchMode>(initialMode);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Focus on mount for hero variant
  useEffect(() => {
    if (variant === "hero") inputRef.current?.focus();
  }, [variant]);

  // Keyboard shortcut: / to focus
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    if (onSearch) {
      onSearch(trimmed, mode);
    } else {
      const params = new URLSearchParams({ q: trimmed, mode });
      router.push(`/search?${params.toString()}`);
    }
  }

  const isHero = variant === "hero";

  return (
    <form onSubmit={handleSubmit} className="w-full">
      {/* Search input */}
      <div
        className={`
          relative flex items-center bg-bg-secondary
          transition-all duration-200
          ${isHero
            ? "h-14 rounded-xl border border-border/70 shadow-lg shadow-black/[0.04] focus-within:border-accent/50 focus-within:shadow-xl focus-within:shadow-accent/[0.06]"
            : "h-11 rounded-xl border border-border-subtle shadow-sm focus-within:border-accent/40"
          }
        `}
      >
        <button
          type="submit"
          className="flex-shrink-0 pe-0 ps-4 text-text-muted/70 hover:text-accent transition-colors"
          aria-label="بحث"
        >
          <Search size={isHero ? 20 : 17} strokeWidth={2.2} />
        </button>

        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ابحث في المقالات الأكاديمية..."
          className={`
            flex-1 bg-transparent px-3 font-arabic text-text-primary
            placeholder:text-text-muted/50 outline-none
            ${isHero ? "text-[15px]" : "text-sm"}
          `}
          dir="rtl"
        />

        {isHero && (
          <button
            type="submit"
            className={`
              flex-shrink-0 me-2 flex items-center gap-1.5 rounded-lg px-5 py-2 text-sm font-semibold transition-all duration-200
              ${query.trim()
                ? "bg-accent text-white shadow-sm hover:bg-accent-hover"
                : "bg-bg-primary text-text-muted cursor-default"
              }
            `}
            disabled={!query.trim()}
          >
            بحث
          </button>
        )}

        {!isHero && query && (
          <button
            type="submit"
            className="flex-shrink-0 me-2 rounded-lg border border-accent/20 bg-accent/[0.06] px-3 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/[0.12]"
          >
            بحث
          </button>
        )}
      </div>

      {/* Mode selector */}
      <div className={`flex items-center gap-1 mt-3 ${isHero ? "justify-center" : ""}`}>
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setMode(m.value)}
            className="relative rounded-lg px-3 py-1.5 text-[13px] transition-colors"
          >
            {mode === m.value && (
              <motion.div
                layoutId={`mode-pill-${variant}`}
                className="absolute inset-0 rounded-lg bg-accent/[0.08]"
                transition={{ type: "spring", stiffness: 500, damping: 35 }}
              />
            )}
            <span
              className={`relative z-10 flex items-center gap-1.5 font-medium ${
                mode === m.value ? "text-accent" : "text-text-muted/70 hover:text-text-secondary"
              }`}
            >
              {m.icon}
              <span className="font-arabic">{m.label}</span>
            </span>
          </button>
        ))}
      </div>
    </form>
  );
}
