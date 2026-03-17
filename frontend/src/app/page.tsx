"use client";

import { useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { BookOpenText } from "lucide-react";
import SearchBar from "@/components/search/SearchBar";
import NetworkBackground, {
  type NetworkHandle,
} from "@/components/network/NetworkBackground";
import EmbeddingAnimation from "@/components/network/EmbeddingAnimation";
import type { SearchMode } from "@/types/search";

type AnimPhase = "idle" | "embedding" | "searching";

export default function Home() {
  const networkRef = useRef<NetworkHandle>(null);
  const router = useRouter();
  const [phase, setPhase] = useState<AnimPhase>("idle");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("hybrid");

  // Refs to hold latest values for callbacks (avoids stale closures)
  const searchQueryRef = useRef("");
  const searchModeRef = useRef<SearchMode>("hybrid");

  const handleSearch = useCallback(
    (query: string, mode: SearchMode) => {
      setSearchQuery(query);
      setSearchMode(mode);
      searchQueryRef.current = query;
      searchModeRef.current = mode;
      setPhase("embedding");
    },
    []
  );

  /** Embedding done → trigger globe search → navigate */
  const handleEmbeddingDone = useCallback(async () => {
    setPhase("searching");
    if (networkRef.current) {
      await networkRef.current.triggerSearch();
    }
    const params = new URLSearchParams({
      q: searchQueryRef.current,
      mode: searchModeRef.current,
    });
    router.push(`/search?${params.toString()}`);
  }, [router]);

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center px-6 overflow-hidden">
      {/* Animated network globe background */}
      <NetworkBackground ref={networkRef} />

      {/* Vignette overlay */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          zIndex: 1,
          background:
            "radial-gradient(ellipse 70% 60% at 50% 50%, transparent 30%, rgba(250,250,250,0.85) 100%)",
        }}
      />

      {/* Darkened overlay during animation */}
      <AnimatePresence>
        {phase !== "idle" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            className="fixed inset-0 pointer-events-none"
            style={{
              zIndex: 2,
              background:
                phase === "embedding"
                  ? "radial-gradient(ellipse 80% 80% at 50% 50%, rgba(250,250,250,0.92) 0%, rgba(250,250,250,0.97) 100%)"
                  : "radial-gradient(ellipse 80% 80% at 50% 50%, rgba(155,27,48,0.04) 0%, rgba(26,26,46,0.10) 100%)",
            }}
          />
        )}
      </AnimatePresence>

      {/* Embedding animation overlay */}
      <AnimatePresence>
        {(phase === "embedding" || phase === "searching") && searchQuery && (
          <motion.div
            key="embedding"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <EmbeddingAnimation
              query={searchQuery}
              onEmbeddingDone={handleEmbeddingDone}
              onComplete={() => {}}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Hero content */}
      <AnimatePresence>
        {phase === "idle" && (
          <motion.div
            key="hero"
            initial={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20, scale: 0.98 }}
            transition={{ duration: 0.4, ease: "easeInOut" }}
            className="relative z-10 flex w-full max-w-[640px] flex-col items-center"
          >
            {/* Logo mark */}
            <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent shadow-md">
              <BookOpenText size={28} className="text-white" />
            </div>

            {/* Branding */}
            <h1 className="mb-1.5 font-arabic text-4xl font-bold text-text-primary">
              المنظومة
            </h1>
            <p className="mb-10 font-arabic text-base text-text-muted">
              محرك بحث أكاديمي ذكي للمقالات العربية
            </p>

            {/* Hero search bar */}
            <SearchBar variant="hero" onSearch={handleSearch} />

            {/* Stats hint */}
            <div className="mt-10 flex items-center gap-6">
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span className="font-arabic">407 مقطع مفهرس</span>
              </div>
              <div className="h-3 w-px bg-border" />
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span className="font-arabic">10 مستندات</span>
              </div>
              <div className="h-3 w-px bg-border" />
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span className="font-arabic">بحث هجين</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Searching phase indicator */}
      <AnimatePresence>
        {phase === "searching" && (
          <motion.div
            key="search-indicator"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, delay: 0.2 }}
            className="fixed bottom-12 z-20 flex items-center gap-3"
          >
            <div className="relative flex items-center gap-3 rounded-full bg-bg-secondary/80 backdrop-blur-xl px-5 py-2.5 shadow-lg border border-border/50">
              <div className="relative h-2 w-2">
                <div className="absolute inset-0 rounded-full bg-accent animate-ping" />
                <div className="relative h-2 w-2 rounded-full bg-accent" />
              </div>
              <span className="font-arabic text-sm text-text-secondary">
                جاري البحث عبر الشبكة...
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
