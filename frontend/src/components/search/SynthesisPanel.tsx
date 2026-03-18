"use client";

import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sparkles, X, RefreshCw, Loader2, AlertCircle } from "lucide-react";
import { streamSynthesis } from "@/lib/api";
import type { SearchResultItem } from "@/types/search";

interface SynthesisPanelProps {
  query: string;
  results: SearchResultItem[];
  onCitationClick?: (zeroBasedIndex: number) => void;
  onSynthesisStateChange?: (active: boolean) => void;
  activeCarouselIndex?: number;
}

type State = "idle" | "streaming" | "done" | "error";

/** Replace (م N) with a markdown link so we can render it as a clickable badge */
function addCitationLinks(text: string): string {
  return text.replace(/\(م\s*(\d+)\)/g, " [م$1](#cite-$1)");
}

export default function SynthesisPanel({
  query,
  results,
  onCitationClick,
  onSynthesisStateChange,
  activeCarouselIndex,
}: SynthesisPanelProps) {
  const [state, setState] = useState<State>("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Inform parent when active state changes
  useEffect(() => {
    onSynthesisStateChange?.(state !== "idle");
  }, [state, onSynthesisStateChange]);

  const startSynthesis = useCallback(async () => {
    setText("");
    setError("");
    setState("streaming");
    abortRef.current = new AbortController();
    try {
      await streamSynthesis(
        query,
        results.slice(0, 10),
        (token) => setText((prev) => prev + token),
        () => setState("done"),
        (msg) => { setError(msg); setState("error"); },
        abortRef.current.signal,
      );
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError("حدث خطأ غير متوقع");
      setState("error");
    }
  }, [query, results]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setState("done");
  }, []);

  const handleReset = useCallback(() => {
    abortRef.current?.abort();
    setState("idle");
    setText("");
    setError("");
  }, []);

  // Custom link renderer — turns [م N](#cite-N) into a clickable citation badge
  const CitationLink = useCallback(
    ({ href, children }: { href?: string; children?: ReactNode }) => {
      if (href?.startsWith("#cite-")) {
        const num = parseInt(href.replace("#cite-", ""), 10);
        const idx = num - 1;
        const isActive = idx === activeCarouselIndex;
        return (
          <button
            onClick={(e) => { e.preventDefault(); onCitationClick?.(idx); }}
            className={`mx-0.5 inline-flex cursor-pointer items-center rounded px-1.5 py-0.5 text-[11px] font-semibold no-underline transition-all ${
              isActive
                ? "bg-rose-600 text-white shadow-sm ring-2 ring-rose-300"
                : "border border-rose-200 bg-rose-100 text-rose-700 hover:bg-rose-500 hover:text-white"
            }`}
          >
            {children}
          </button>
        );
      }
      return <a href={href} className="text-rose-600 hover:underline">{children}</a>;
    },
    [activeCarouselIndex, onCitationClick],
  );

  if (results.length === 0) return null;

  // ── Idle: compact trigger banner ─────────────────────────────────────────
  if (state === "idle") {
    return (
      <div className="mb-5 flex items-center gap-3 rounded-xl border border-dashed border-border bg-bg-elevated px-4 py-3">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-rose-50">
          <Sparkles size={14} className="text-rose-500" />
        </div>
        <p className="flex-1 font-arabic text-sm text-text-muted leading-relaxed">
          احصل على تحليل أكاديمي مفصل يقارن المصادر ويستخرج الإحصاءات والنتائج
        </p>
        <button
          onClick={startSynthesis}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-[12px] font-arabic font-medium text-white transition hover:bg-rose-700"
        >
          <Sparkles size={11} />
          تحليل النتائج
        </button>
      </div>
    );
  }

  // ── Active: full left-column analysis panel ───────────────────────────────
  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-100">
            <Sparkles size={14} className="text-rose-600" />
          </div>
          <h2 className="font-arabic text-base font-semibold text-text-primary">
            تحليل المصادر
          </h2>
          {state === "streaming" && (
            <Loader2 size={14} className="animate-spin text-rose-500" />
          )}
        </div>
        <div className="flex items-center gap-2">
          {state === "streaming" && (
            <button
              onClick={handleStop}
              className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-arabic text-text-muted transition hover:text-text-primary"
            >
              <X size={11} /> إيقاف
            </button>
          )}
          {state === "done" && (
            <button
              onClick={startSynthesis}
              className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-arabic text-text-muted transition hover:text-text-primary"
            >
              <RefreshCw size={11} /> إعادة
            </button>
          )}
          <button
            onClick={handleReset}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-border text-text-muted transition hover:text-text-primary"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Content */}
      {state === "error" ? (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-700">
          <AlertCircle size={15} className="mt-0.5 flex-shrink-0" />
          <p className="font-arabic text-sm">{error}</p>
        </div>
      ) : (
        <div className="prose prose-sm max-w-none font-arabic text-[14px] leading-relaxed text-text-primary [direction:rtl] [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-[13px] [&_h3]:font-bold [&_h3]:text-text-primary [&_li]:mb-1.5 [&_li]:leading-[1.8] [&_ol]:mt-1 [&_p]:mb-3 [&_p]:leading-[1.85] [&_strong]:text-text-primary [&_ul]:mt-1">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: CitationLink }}>
            {addCitationLinks(text)}
          </ReactMarkdown>
          {state === "streaming" && (
            <span className="inline-block h-4 w-0.5 animate-pulse bg-rose-500 align-middle" />
          )}
        </div>
      )}

      {state === "done" && (
        <p className="border-t border-border-subtle pt-3 text-[11px] text-text-muted font-arabic">
          استُند إلى {Math.min(results.length, 10)} مقتطف. م١، م٢... تشير إلى أرقام المراجع في العرض الجانبي.
        </p>
      )}
    </div>
  );
}
