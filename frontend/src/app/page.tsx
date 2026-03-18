"use client";

import { useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import SearchBar from "@/components/search/SearchBar";
import NetworkBackground, {
  type NetworkHandle,
} from "@/components/network/NetworkBackground";
import SonarPulseAnimation from "@/components/network/SonarPulseAnimation";
import SearchPreview from "@/components/network/SearchPreview";
import { search } from "@/lib/api";
import { setPrefetchedSearch } from "@/lib/hooks/useSearch";
import type { SearchMode, SearchResponse } from "@/types/search";
import type { SearchResultItem } from "@/types/search";

type AnimPhase = "idle" | "embedding" | "searching";

export default function Home() {
  const networkRef = useRef<NetworkHandle>(null);
  const router = useRouter();
  const [phase, setPhase] = useState<AnimPhase>("idle");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("hybrid");

  const searchQueryRef = useRef("");
  const searchModeRef = useRef<SearchMode>("hybrid");
  const pendingScoresRef = useRef<number[]>([]);
  const [previewResults, setPreviewResults] = useState<SearchResultItem[]>([]);
  const searchPromiseRef = useRef<Promise<SearchResponse | null> | null>(null);
  const revealCanvasRef = useRef<HTMLCanvasElement>(null);
  const revealRafRef = useRef(0);

  const handleSearch = useCallback(
    (query: string, mode: SearchMode) => {
      setSearchQuery(query);
      setSearchMode(mode);
      searchQueryRef.current = query;
      searchModeRef.current = mode;
      pendingScoresRef.current = [];
      setPreviewResults([]);
      setPhase("embedding");

      const promise = search({ query, mode, top_k: 20 })
        .then(res => {
          pendingScoresRef.current = res.results.map(r => r.score);
          setPreviewResults(res.results.slice(0, 5));
          setPrefetchedSearch({ query, mode, top_k: 20 }, res);
          return res;
        })
        .catch(() => null);
      searchPromiseRef.current = promise;
    },
    []
  );

  const handleEmbeddingDone = useCallback(async () => {
    // Wait for API results before transitioning to search phase
    await searchPromiseRef.current;

    // Circular reveal: white overlay with expanding hole from center
    const canvas = revealCanvasRef.current;
    if (canvas) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      canvas.width = vw * dpr;
      canvas.height = vh * dpr;
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${vh}px`;
      canvas.style.display = "block";
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const maxR = Math.sqrt(vw * vw + vh * vh) / 2;
        const ccx = (vw * dpr) / 2;
        const ccy = (vh * dpr) / 2;
        const start = performance.now();
        const DURATION = 700;

        const animateReveal = (now: number) => {
          const t = Math.min((now - start) / DURATION, 1);
          const eased = 1 - (1 - t) * (1 - t);
          const r = eased * maxR * dpr;

          ctx.clearRect(0, 0, canvas.width, canvas.height);

          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, canvas.width, canvas.height);
          ctx.arc(ccx, ccy, r, 0, Math.PI * 2, true);
          ctx.fillStyle = "rgba(250,250,250,0.95)";
          ctx.fill();
          ctx.restore();

          // Accent glow ring at the expanding edge
          if (r > 0) {
            const glowAlpha = 0.25 * (1 - t * 0.7);
            ctx.beginPath();
            ctx.arc(ccx, ccy, r, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(155,27,48,${glowAlpha})`;
            ctx.lineWidth = 6 * dpr;
            ctx.stroke();
          }

          if (t < 1) {
            revealRafRef.current = requestAnimationFrame(animateReveal);
          } else {
            canvas.style.display = "none";
          }
        };
        revealRafRef.current = requestAnimationFrame(animateReveal);
      }
    }

    setPhase("searching");
    if (networkRef.current) {
      await networkRef.current.triggerSearch(pendingScoresRef.current);
    }
    const params = new URLSearchParams({
      q: searchQueryRef.current,
      mode: searchModeRef.current,
    });
    router.push(`/search?${params.toString()}`);
  }, [router]);

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

      {/* Circular reveal overlay */}
      <canvas
        ref={revealCanvasRef}
        className="fixed inset-0 pointer-events-none"
        style={{ zIndex: 5, display: "none" }}
        aria-hidden="true"
      />

      {/* Result preview cards connected to globe nodes */}
      <SearchPreview
        results={previewResults}
        networkRef={networkRef}
        active={phase === "searching"}
      />
    </div>
  );
}
