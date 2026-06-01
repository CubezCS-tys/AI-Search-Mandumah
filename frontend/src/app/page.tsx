"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { MessageSquare } from "lucide-react";
import SearchBar from "@/components/search/SearchBar";
import NetworkBackground, {
  type NetworkHandle,
} from "@/components/network/NetworkBackground";
import SonarPulseAnimation from "@/components/network/SonarPulseAnimation";
import SearchPreview from "@/components/network/SearchPreview";
import { search } from "@/lib/api";
import { setPrefetchedSearch } from "@/lib/hooks/useSearch";
import type { SearchMode } from "@/types/search";
import type { SearchResultItem } from "@/types/search";

type AnimPhase = "idle" | "embedding" | "searching";

export default function Home() {
  const networkRef = useRef<NetworkHandle>(null);
  const router = useRouter();
  const [phase, setPhase] = useState<AnimPhase>("idle");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHyde, setSearchHyde] = useState(false);

  const searchQueryRef = useRef("");
  const searchModeRef = useRef<SearchMode>("hybrid");
  const searchHydeRef = useRef(false);
  const pendingScoresRef = useRef<number[]>([]);
  const [previewResults, setPreviewResults] = useState<SearchResultItem[]>([]);

  // Live stats from Qdrant
  const [stats, setStats] = useState<{ chunks: number; documents: number } | null>(null);
  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => { if (d.chunks) setStats({ chunks: d.chunks, documents: d.documents }); })
      .catch(() => {});
  }, []);
  const apiDoneRef = useRef(false);
  const animDoneRef = useRef(false);
  const searchingRef = useRef(false);

  // When API results arrive and globe is already showing, fire real search
  const maybeRealSearch = useCallback(() => {
    if (!apiDoneRef.current || !animDoneRef.current) return;
    if (searchingRef.current) return; // already fired
    searchingRef.current = true;
    // Trigger the real search animation with actual scores
    if (networkRef.current) {
      networkRef.current.triggerSearch(pendingScoresRef.current);
    }
    // Navigate after the real globe animation plays
    setTimeout(() => {
      const params = new URLSearchParams({
        q: searchQueryRef.current,
        mode: searchModeRef.current,
      });
      if (searchHydeRef.current) params.set("hyde", "1");
      router.push(`/search?${params.toString()}`);
    }, 2500);
  }, [router]);

  const handleSearch = useCallback(
    (query: string, mode: SearchMode, hyde: boolean) => {
      setSearchQuery(query);
      setSearchHyde(hyde);
      searchQueryRef.current = query;
      searchModeRef.current = mode;
      searchHydeRef.current = hyde;
      pendingScoresRef.current = [];
      setPreviewResults([]);
      apiDoneRef.current = false;
      animDoneRef.current = false;
      searchingRef.current = false;
      setPhase("embedding");

      search({ query, mode, top_k: 20, hyde })
        .then(res => {
          pendingScoresRef.current = res.results.map(r => r.score);
          setPreviewResults(res.results.slice(0, 5));
          setPrefetchedSearch({ query, mode, top_k: 20, hyde }, res);
          apiDoneRef.current = true;
          maybeRealSearch();
          return res;
        })
        .catch(() => {
          apiDoneRef.current = true;
          maybeRealSearch();
        });
    },
    [maybeRealSearch]
  );

  const handleEmbeddingDone = useCallback(() => {
    animDoneRef.current = true;
    // Show globe immediately with idle pulses
    setPhase("searching");
    if (networkRef.current) {
      networkRef.current.startIdlePulse();
    }
    // If API already done, fire real search right away
    maybeRealSearch();
  }, [maybeRealSearch]);

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center px-6 overflow-hidden">
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
        {phase === "embedding" && searchQuery && (
          <motion.div
            key="embedding"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.25 } }}
            transition={{ duration: 0.5 }}
          >
            <SonarPulseAnimation
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
            <Image
              src="/logo_ar.svg"
              alt="المنظومة"
              width={220}
              height={114}
              className="mb-3 drop-shadow-sm"
              priority
            />
            <p className="mb-10 font-arabic text-base text-text-muted">
              محرك بحث أكاديمي ذكي للمقالات العربية
            </p>

            <SearchBar variant="hero" onSearch={handleSearch} />

            <button
              onClick={() => router.push("/chat")}
              className="mt-4 inline-flex items-center gap-2 rounded-full border border-border bg-bg-elevated px-4 py-2 font-arabic text-[13px] font-medium text-text-secondary shadow-sm transition hover:border-accent/40 hover:text-accent"
            >
              <MessageSquare size={14} className="text-accent" />
              أو ابدأ محادثة ذكية عبر المجموعة
            </button>

            <div className="mt-10 flex items-center gap-6">
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span className="font-arabic">{stats ? `${stats.chunks.toLocaleString("en-US")} مقطع مفهرس` : "..."}</span>
              </div>
              <div className="h-3 w-px bg-border" />
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span className="font-arabic">{stats ? `${stats.documents.toLocaleString("en-US")} مستندات` : "..."}</span>
              </div>
              <div className="h-3 w-px bg-border" />
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span className="font-arabic">{searchHyde ? "HyDE مفعل" : "HyDE اختياري"}</span>
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

      {/* Result preview cards connected to globe nodes */}
      <SearchPreview
        results={previewResults}
        networkRef={networkRef}
        active={phase === "searching"}
      />
    </div>
  );
}
