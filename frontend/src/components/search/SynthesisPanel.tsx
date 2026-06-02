"use client";

import { useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Sparkles, X, RefreshCw, Loader2, AlertCircle, Zap, FlaskConical,
  Copy, Check, Download, ListTree, ExternalLink, BookOpen, Quote, Clock, ChevronDown,
} from "lucide-react";
import { streamSynthesis } from "@/lib/api";
import type { SearchMode, SearchResultItem, SynthesisMode } from "@/types/search";

interface SynthesisPanelProps {
  query: string;
  results: SearchResultItem[];
  synthesisMode: SynthesisMode;
  searchMode: SearchMode;
  hydeEnabled: boolean;
  filters: {
    journalId: string;
    section: string;
    docId: string;
  };
  onSynthesisModeChange: (mode: SynthesisMode) => void;
  onCitationClick?: (zeroBasedIndex: number) => void;
  onSynthesisStateChange?: (active: boolean) => void;
  activeCarouselIndex?: number;
}

type State = "idle" | "streaming" | "done" | "error";

const MODE_TOGGLE_BASE =
  "inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-[12px] font-arabic font-medium transition-all duration-150";
const MODE_TOGGLE_ACTIVE =
  "bg-bg-elevated text-accent shadow-sm ring-1 ring-accent/20 translate-y-[-0.5px]";
const MODE_TOGGLE_INACTIVE =
  "border border-transparent bg-transparent text-text-muted hover:border-border hover:bg-bg-primary hover:text-text-primary";

/** Replace (م N) with a markdown link so we can render it as a clickable badge */
function addCitationLinks(text: string): string {
  return text.replace(/\(م\s*(\d+)\)/g, " [م$1](#cite-$1)");
}

/** Stable, unicode-safe id for a heading so the outline can scroll to it. */
function slugify(s: string): string {
  return "syn-" + s.trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}-]/gu, "");
}

/** Flatten React children to plain text (for heading ids / outline labels). */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && node !== null && "props" in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

/** Source numbers (1-based) actually cited via (م N) markers in the answer. */
function citedNumbers(text: string): Set<number> {
  const set = new Set<number>();
  for (const m of text.matchAll(/\(م\s*(\d+)\)/g)) set.add(parseInt(m[1], 10));
  return set;
}

export default function SynthesisPanel({
  query,
  results,
  synthesisMode,
  searchMode,
  hydeEnabled,
  filters,
  onSynthesisModeChange,
  onCitationClick,
  onSynthesisStateChange,
  activeCarouselIndex,
}: SynthesisPanelProps) {
  const [state, setState] = useState<State>("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showRefs, setShowRefs] = useState(true);
  const [activeId, setActiveId] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isAdvanced = synthesisMode === "advanced";
  const sourceCount = isAdvanced ? 20 : 10;

  // Inform parent when active state changes
  useEffect(() => {
    onSynthesisStateChange?.(state !== "idle");
  }, [state, onSynthesisStateChange]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const startSynthesis = useCallback(async () => {
    setText("");
    setError("");
    setState("streaming");
    abortRef.current = new AbortController();
    try {
      await streamSynthesis(
        {
          query,
          results: results.slice(0, sourceCount),
          mode: isAdvanced ? "advanced" : "fast",
          max_documents: isAdvanced ? 5 : undefined,
          chunks_per_document: isAdvanced ? 4 : undefined,
          use_hyde: hydeEnabled,
          search_mode: searchMode,
          journal_id: filters.journalId || undefined,
          section: filters.section || undefined,
          doc_id: filters.docId || undefined,
        },
        (token) => setText((prev) => prev + token),
        () => setState("done"),
        (msg) => {
          setError(msg);
          setState("error");
        },
        abortRef.current.signal,
      );
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError("حدث خطأ غير متوقع");
      setState("error");
    }
  }, [filters.docId, filters.journalId, filters.section, hydeEnabled, isAdvanced, query, results, searchMode, sourceCount]);

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

  // Use refs so the custom renderer component identities stay stable across
  // re-renders, preventing ReactMarkdown DOM reconciliation crashes mid-stream.
  const activeIndexRef = useRef(activeCarouselIndex);
  const citationClickRef = useRef(onCitationClick);
  const resultsRef = useRef(results);
  useEffect(() => { activeIndexRef.current = activeCarouselIndex; }, [activeCarouselIndex]);
  useEffect(() => { citationClickRef.current = onCitationClick; }, [onCitationClick]);
  useEffect(() => { resultsRef.current = results; }, [results]);

  // Outline parsed live from the streamed markdown headings (### …).
  const outline = useMemo(() => {
    const items: { id: string; title: string }[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(/^###\s+(.+?)\s*$/gm)) {
      const title = m[1].trim();
      const id = slugify(title);
      if (!seen.has(id)) { seen.add(id); items.push({ id, title }); }
    }
    return items;
  }, [text]);

  // Which sources were actually cited, plus reading stats.
  const cited = useMemo(() => citedNumbers(text), [text]);
  const usedCount = Math.min(results.length, sourceCount);
  const wordCount = useMemo(() => (text.trim() ? text.trim().split(/\s+/).length : 0), [text]);
  const readingMin = Math.max(1, Math.round(wordCount / 180));

  // Scrollspy — highlight the outline entry for the section currently in view.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const headings = Array.from(root.querySelectorAll<HTMLElement>("h3[id]"));
    if (headings.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActiveId((vis[0].target as HTMLElement).id);
      },
      { rootMargin: "-110px 0px -65% 0px", threshold: 0 },
    );
    headings.forEach((h) => obs.observe(h));
    return () => obs.disconnect();
  }, [outline.length, state]);

  const jumpTo = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Build a clean markdown export: synthesis + auto-generated reference list.
  const buildExport = useCallback(() => {
    const refs = results.slice(0, sourceCount).map((r, i) => {
      const mark = cited.has(i + 1) ? "" : " *(غير مُستشهد به مباشرة)*";
      return `${i + 1}. **${r.title}** — ${r.section || "—"} \`[${r.doc_id}]\`${mark}`;
    });
    return [
      `# تحليل المصادر`,
      ``,
      `**السؤال:** ${query}`,
      `**الوضع:** ${isAdvanced ? "متقدم" : "عادي"} · **المصادر:** ${usedCount} · **المُستشهد بها:** ${cited.size}`,
      ``,
      text.trim(),
      ``,
      `## المراجع`,
      ``,
      ...refs,
      ``,
    ].join("\n");
  }, [results, sourceCount, cited, query, isAdvanced, usedCount, text]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildExport());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable */ }
  }, [buildExport]);

  const handleExport = useCallback(() => {
    const blob = new Blob([buildExport()], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `تحليل-المصادر-${Date.now()}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [buildExport]);

  // Custom heading renderer — assigns a stable id so the outline can scroll to it.
  const Heading = useMemo(
    () =>
      function HeadingInner({ children }: { children?: ReactNode }) {
        return (
          <h3 id={slugify(nodeText(children))} className="scroll-mt-28">
            {children}
          </h3>
        );
      },
    [],
  );

  // Custom link renderer — turns [م N](#cite-N) into a clickable citation badge
  // with a hover preview of the cited source. Memoized for stable identity to
  // avoid the "insertBefore" DOM crash when ReactMarkdown reconciles mid-stream.
  const CitationLink = useMemo(
    () =>
      function CitationLinkInner({ href, children }: { href?: string; children?: ReactNode }) {
        if (href?.startsWith("#cite-")) {
          const num = parseInt(href.replace("#cite-", ""), 10);
          const idx = num - 1;
          const isActive = idx === activeIndexRef.current;
          const src = resultsRef.current[idx];
          return (
            <span className="group/cite relative inline-block align-baseline">
              <button
                onClick={(e) => { e.preventDefault(); citationClickRef.current?.(idx); }}
                className={`mx-0.5 inline-flex cursor-pointer items-center rounded px-1.5 py-0.5 text-[11px] font-semibold no-underline transition-all ${
                  isActive
                    ? "bg-accent text-white shadow-sm ring-2 ring-accent/30"
                    : "border border-accent/30 bg-accent-subtle text-accent hover:bg-accent hover:text-white"
                }`}
              >
                {children}
              </button>
              {src && (
                <span
                  dir="rtl"
                  className="pointer-events-none invisible absolute bottom-full right-0 z-50 mb-1.5 flex w-64 flex-col gap-1 rounded-xl border border-border bg-bg-elevated p-3 text-right opacity-0 shadow-lg transition-opacity duration-150 group-hover/cite:visible group-hover/cite:opacity-100"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-accent px-1 text-[10px] font-bold text-white" dir="ltr">{num}</span>
                    {src.section && (
                      <span className="rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-muted">{src.section}</span>
                    )}
                    <span className="ms-auto text-[10px] tabular-nums text-text-muted" dir="ltr">{src.score.toFixed(3)}</span>
                  </span>
                  <span className="line-clamp-2 font-arabic text-[12px] font-semibold leading-snug text-text-primary">{src.title}</span>
                  <span className="line-clamp-3 font-arabic text-[11px] leading-relaxed text-text-muted">{src.text}</span>
                  <span className="mt-0.5 text-[10px] text-accent">انقر للمعاينة في اللوحة الجانبية</span>
                </span>
              )}
            </span>
          );
        }
        return <a href={href} className="text-accent hover:underline">{children}</a>;
      },
    [],
  );

  if (results.length === 0) return null;

  // ── Idle: compact trigger banner ─────────────────────────────────────────
  if (state === "idle") {
    return (
      <div className="mb-5 flex flex-col gap-3 rounded-xl border border-dashed border-border bg-bg-elevated px-4 py-3 sm:flex-row sm:items-center">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-rose-50">
          <Sparkles size={14} className="text-rose-500" />
        </div>
        <div className="flex-1">
          <p className="font-arabic text-sm text-text-muted leading-relaxed">
            احصل على تحليل أكاديمي يقارن المصادر ويستخرج الإحصاءات والنتائج.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={() => onSynthesisModeChange("standard")}
              className={`${MODE_TOGGLE_BASE} ${
                synthesisMode === "standard"
                  ? MODE_TOGGLE_ACTIVE
                  : MODE_TOGGLE_INACTIVE
              }`}
            >
              <Zap size={11} />
              عادي
            </button>
            <button
              onClick={() => onSynthesisModeChange("advanced")}
              className={`${MODE_TOGGLE_BASE} ${
                synthesisMode === "advanced"
                  ? MODE_TOGGLE_ACTIVE
                  : MODE_TOGGLE_INACTIVE
              }`}
            >
              <FlaskConical size={11} />
              متقدم
            </button>
          </div>
        </div>
        <button
          onClick={startSynthesis}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-[12px] font-arabic font-medium text-white transition hover:bg-rose-700"
        >
          <Sparkles size={11} />
          {isAdvanced ? "تحليل متقدم" : "تحليل النتائج"}
        </button>
      </div>
    );
  }

  // ── Active: full research answer workspace ────────────────────────────────
  const refList = results.slice(0, sourceCount);
  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-subtle">
            <Sparkles size={14} className="text-accent" />
          </div>
          <h2 className="font-arabic text-base font-semibold text-text-primary">
            تحليل المصادر
          </h2>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            isAdvanced
              ? "bg-amber-100 text-amber-700"
              : "bg-bg-secondary text-text-secondary"
          }`}>
            {isAdvanced ? "متقدم" : "عادي"}
          </span>
          {state === "streaming" && (
            <Loader2 size={14} className="animate-spin text-accent" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-1 rounded-full border border-border bg-bg-elevated/90 p-1 sm:flex">
            <button
              onClick={() => onSynthesisModeChange("standard")}
              disabled={state === "streaming"}
              className={`${MODE_TOGGLE_BASE} disabled:opacity-50 disabled:cursor-not-allowed ${
                synthesisMode === "standard" ? MODE_TOGGLE_ACTIVE : MODE_TOGGLE_INACTIVE
              }`}
            >
              عادي
            </button>
            <button
              onClick={() => onSynthesisModeChange("advanced")}
              disabled={state === "streaming"}
              className={`${MODE_TOGGLE_BASE} disabled:opacity-50 disabled:cursor-not-allowed ${
                synthesisMode === "advanced" ? MODE_TOGGLE_ACTIVE : MODE_TOGGLE_INACTIVE
              }`}
            >
              متقدم
            </button>
          </div>
          {state === "streaming" && (
            <button
              onClick={handleStop}
              aria-label="إيقاف التحليل"
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
            aria-label="إغلاق التحليل"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-border text-text-muted transition hover:text-text-primary"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Research metrics + export actions */}
      {state !== "error" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border-subtle bg-bg-elevated px-3.5 py-2.5">
          <span className="flex items-center gap-1.5 font-arabic text-[11px] text-text-muted">
            <BookOpen size={12} className="text-accent" /> {usedCount} مصدر
          </span>
          <span className="flex items-center gap-1.5 font-arabic text-[11px] text-text-muted">
            <Quote size={12} className="text-accent" /> استُشهد بـ <span dir="ltr">{cited.size}</span>
          </span>
          {wordCount > 0 && (
            <>
              <span className="flex items-center gap-1.5 font-arabic text-[11px] text-text-muted">
                <Clock size={12} className="text-accent" /> ~{readingMin} دقيقة
              </span>
              <span className="font-arabic text-[11px] text-text-muted">
                <span dir="ltr">{wordCount.toLocaleString("en-US")}</span> كلمة
              </span>
            </>
          )}
          <div className="ms-auto flex items-center gap-1.5">
            <button
              onClick={handleCopy}
              disabled={!text}
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 font-arabic text-[11px] text-text-secondary transition hover:text-text-primary disabled:opacity-40"
            >
              {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
              {copied ? "تم النسخ" : "نسخ"}
            </button>
            <button
              onClick={handleExport}
              disabled={state !== "done"}
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 font-arabic text-[11px] text-text-secondary transition hover:text-text-primary disabled:opacity-40"
            >
              <Download size={12} /> تصدير
            </button>
          </div>
        </div>
      )}

      {/* Section outline — sticky jump chips with scrollspy */}
      {outline.length > 1 && state !== "error" && (
        <div className="sticky top-[92px] z-20 -mx-1 flex items-center gap-1.5 overflow-x-auto rounded-lg border border-border-subtle bg-bg-primary/85 px-1.5 py-1.5 backdrop-blur">
          <ListTree size={13} className="ms-1 flex-shrink-0 text-text-muted" />
          {outline.map((o) => (
            <button
              key={o.id}
              onClick={() => jumpTo(o.id)}
              className={`flex-shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 font-arabic text-[11px] transition ${
                activeId === o.id
                  ? "bg-accent text-white"
                  : "bg-bg-secondary text-text-secondary hover:text-text-primary"
              }`}
            >
              {o.title}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      {state === "error" ? (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-700">
          <AlertCircle size={15} className="mt-0.5 flex-shrink-0" />
          <p className="font-arabic text-sm">{error}</p>
        </div>
      ) : (
        <div ref={contentRef} className="prose prose-sm max-w-none font-arabic text-[14px] leading-relaxed text-text-primary [direction:rtl] [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-[13px] [&_h3]:font-bold [&_h3]:text-text-primary [&_li]:mb-1.5 [&_li]:leading-[1.8] [&_ol]:mt-1 [&_p]:mb-3 [&_p]:leading-[1.85] [&_strong]:text-text-primary [&_ul]:mt-1">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: CitationLink, h3: Heading }}>
            {addCitationLinks(text)}
          </ReactMarkdown>
          {state === "streaming" && (
            <span className="inline-block h-4 w-0.5 animate-pulse bg-accent align-middle" />
          )}
        </div>
      )}

      {/* References / generated bibliography */}
      {state === "done" && refList.length > 0 && (
        <div className="rounded-xl border border-border-subtle bg-bg-elevated">
          <button
            onClick={() => setShowRefs((v) => !v)}
            className="flex w-full items-center justify-between px-3.5 py-2.5"
          >
            <span className="flex items-center gap-2 font-arabic text-[13px] font-semibold text-text-primary">
              <BookOpen size={14} className="text-accent" /> المراجع
              <span className="rounded-full bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-muted" dir="ltr">
                {refList.length}
              </span>
            </span>
            <ChevronDown size={15} className={`text-text-muted transition-transform ${showRefs ? "rotate-180" : ""}`} />
          </button>
          {showRefs && (
            <ol className="flex flex-col gap-1.5 px-2.5 pb-3 pt-1">
              {refList.map((r, i) => {
                const isCited = cited.has(i + 1);
                const isActive = i === activeCarouselIndex;
                return (
                  <li key={r.chunk_id}>
                    <div className={`group flex items-start gap-2.5 rounded-lg border p-2.5 transition ${
                      isActive
                        ? "border-accent/40 bg-accent-subtle"
                        : isCited
                          ? "border-border-subtle bg-bg-secondary/50 hover:border-border"
                          : "border-transparent opacity-70 hover:opacity-100"
                    }`}>
                      <span className={`mt-0.5 inline-flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded px-1 text-[11px] font-bold ${
                        isCited ? "bg-accent text-white" : "bg-bg-secondary text-text-muted"
                      }`} dir="ltr">
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <button
                          onClick={() => onCitationClick?.(i)}
                          className="block w-full text-right font-arabic text-[12.5px] font-semibold leading-snug text-text-primary line-clamp-2 hover:text-accent"
                        >
                          {r.title}
                        </button>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-text-muted">
                          {r.section && <span className="rounded bg-bg-secondary px-1.5 py-0.5">{r.section}</span>}
                          <span dir="ltr" className="font-mono">{r.doc_id}</span>
                          <span dir="ltr" className="tabular-nums">{r.score.toFixed(3)}</span>
                          {!isCited && <span className="text-text-muted/70">— غير مُستشهد به مباشرة</span>}
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
                        <button
                          onClick={() => onCitationClick?.(i)}
                          title="معاينة"
                          className="rounded-md p-1 text-text-muted hover:bg-bg-secondary hover:text-accent"
                        >
                          <Quote size={13} />
                        </button>
                        <Link
                          href={`/document/${r.doc_id}?q=${encodeURIComponent(query)}`}
                          title="فتح المستند"
                          className="rounded-md p-1 text-text-muted hover:bg-bg-secondary hover:text-accent"
                        >
                          <ExternalLink size={13} />
                        </Link>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}

      {state === "done" && (
        <p className="font-arabic text-[11px] text-text-muted">
          استُند إلى {usedCount} {isAdvanced ? "مصدر أولي" : "مقتطف"}. أرقام (م) تشير إلى المراجع أعلاه وفي العرض الجانبي.
        </p>
      )}
    </div>
  );
}
