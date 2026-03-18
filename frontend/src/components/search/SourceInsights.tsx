"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  Sparkles,
  MessageSquare,
  Loader2,
} from "lucide-react";
import type { SearchResultItem } from "@/types/search";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/* ── Types ──────────────────────────────────────────────────── */

interface AnalysisResult {
  title?: string;
  authors?: string;
  summary?: string;
  methodology?: string;
  insights: { icon: string; label: string; text: string; quote: string }[];
}

/* ── Cache helpers (reuse same localStorage keys as ChatPanel) ── */

function loadCached(docId: string): AnalysisResult | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(`doc_analysis_${docId}`);
    if (stored) return JSON.parse(stored);
  } catch { /* corrupted */ }
  return null;
}

function saveCache(docId: string, data: AnalysisResult) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(`doc_analysis_${docId}`, JSON.stringify(data));
  } catch { /* full */ }
}

/* ── Component ──────────────────────────────────────────────── */

interface SourceInsightsProps {
  result: SearchResultItem;
  query: string;
}

export default function SourceInsights({ result, query }: SourceInsightsProps) {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const docId = result.doc_id;

  useEffect(() => {
    setError(false);

    const cached = loadCached(docId);
    if (cached) {
      setAnalysis(cached);
      setLoading(false);
      return;
    }

    setAnalysis(null);
    setLoading(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    fetch(`${API_BASE}/api/analyze/${docId}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: AnalysisResult) => {
        setAnalysis(data);
        saveCache(docId, data);
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(true);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [docId]);

  const docHref = `/document/${docId}?q=${encodeURIComponent(query)}&highlight=${encodeURIComponent(result.text)}`;

  /* ── Loading state ── */
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2" dir="rtl">
        <Loader2 size={12} className="animate-spin text-rose-500 shrink-0" />
        <p className="text-[11px] text-text-muted font-arabic">جارٍ تحليل المصدر...</p>
      </div>
    );
  }

  /* ── Error / no analysis ── */
  if (error || !analysis) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2" dir="rtl">
        <p className="text-[11px] text-text-muted font-arabic">لا يمكن تحليل هذا المصدر</p>
        <Link
          href={docHref}
          className="flex items-center gap-1 rounded-md bg-rose-600 px-2 py-0.5 text-[10px] font-arabic text-white hover:bg-rose-700 transition"
        >
          <MessageSquare size={10} />
          فتح المستند
        </Link>
      </div>
    );
  }

  /* ── Compact info strip — just essentials ── */
  return (
    <div className="rounded-lg border border-border-subtle bg-white px-3 py-2.5 space-y-1.5" dir="rtl">
      {/* Title + author row */}
      <div className="flex items-start gap-2">
        <Sparkles size={12} className="text-rose-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <h3 className="text-[12px] font-bold text-text-primary font-arabic leading-snug line-clamp-1">
            {analysis.title || result.title}
          </h3>
          {analysis.authors && (
            <p className="text-[10px] text-text-muted font-arabic truncate">{analysis.authors}</p>
          )}
        </div>
      </div>

      {/* Brief summary — max 2 lines */}
      {analysis.summary && (
        <p className="text-[11px] text-text-secondary font-arabic leading-relaxed line-clamp-2">
          {analysis.summary}
        </p>
      )}

      {/* Open document link */}
      <Link
        href={docHref}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-rose-200 bg-rose-50/50 px-2 py-1.5 text-[11px] font-arabic font-medium text-rose-600 hover:bg-rose-100 transition-colors"
      >
        <MessageSquare size={11} />
        فتح المستند والمحادثة
      </Link>
    </div>
  );
}
