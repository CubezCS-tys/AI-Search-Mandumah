"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { X, ExternalLink, Loader2, ZoomIn, ZoomOut, AlertCircle } from "lucide-react";
import Link from "next/link";
import type { SearchResultItem } from "@/types/search";

/* ── OCR types ──────────────────────────────────────────────── */

interface OcrWord {
  content: string;
  polygon: number[];
  confidence: number;
}

interface OcrPage {
  pageNumber: number;
  width: number;
  height: number;
  unit: string;
  angle: number;
  rasterWidth: number;
  rasterHeight: number;
  words: OcrWord[];
  lines: { content: string; polygon: number[] }[];
}

interface OcrData {
  pages: OcrPage[];
}

/* ── Text matching utilities ────────────────────────────────── */

function polygonToRect(polygon: number[], scaleX: number, scaleY: number) {
  const xs = [polygon[0], polygon[2], polygon[4], polygon[6]];
  const ys = [polygon[1], polygon[3], polygon[5], polygon[7]];
  return {
    left: Math.min(...xs) * scaleX,
    top: Math.min(...ys) * scaleY,
    width: (Math.max(...xs) - Math.min(...xs)) * scaleX,
    height: (Math.max(...ys) - Math.min(...ys)) * scaleY,
  };
}

function stripTashkeel(s: string) {
  return s.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g, "");
}

function stripPunctuation(s: string) {
  return s.replace(/[.,،؛:؟!()\[\]{}«»"'\-–—٪%\/\\]/g, "");
}

function normalizeWord(s: string) {
  return stripPunctuation(stripTashkeel(s)).toLowerCase().trim();
}

type FlatWord = { norm: string; globalIdx: number };

function findExactConsecutive(allWords: FlatWord[], citTokens: string[]): Set<number> {
  const matched = new Set<number>();
  for (let i = 0; i <= allWords.length - citTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < citTokens.length; j++) {
      if (allWords[i + j].norm !== citTokens[j]) { ok = false; break; }
    }
    if (ok) {
      for (let j = 0; j < citTokens.length; j++) matched.add(allWords[i + j].globalIdx);
      return matched;
    }
  }
  return matched;
}

function findTolerantWindow(allWords: FlatWord[], citTokens: string[]): Set<number> {
  const maxMiss = Math.max(1, Math.floor(citTokens.length * 0.1));
  let bestStart = -1;
  let bestMisses = citTokens.length + 1;
  for (let i = 0; i <= allWords.length - citTokens.length; i++) {
    let misses = 0;
    for (let j = 0; j < citTokens.length; j++) {
      if (allWords[i + j].norm !== citTokens[j]) {
        misses++;
        if (misses > maxMiss) break;
      }
    }
    if (misses <= maxMiss && misses < bestMisses) {
      bestMisses = misses;
      bestStart = i;
      if (misses === 0) break;
    }
  }
  const matched = new Set<number>();
  if (bestStart >= 0) {
    for (let j = 0; j < citTokens.length; j++) matched.add(allWords[bestStart + j].globalIdx);
  }
  return matched;
}

function findSubstringMatch(allWords: FlatWord[], citNorm: string): Set<number> {
  if (citNorm.length < 8) return new Set<number>();
  const charToWord: number[] = [];
  let text = "";
  for (let i = 0; i < allWords.length; i++) {
    if (i > 0) { text += " "; charToWord.push(-1); }
    for (let c = 0; c < allWords[i].norm.length; c++) {
      text += allWords[i].norm[c];
      charToWord.push(i);
    }
  }
  const pos = text.indexOf(citNorm);
  if (pos === -1) return new Set<number>();
  const matched = new Set<number>();
  for (let c = pos; c < pos + citNorm.length; c++) {
    const wi = charToWord[c];
    if (wi >= 0) matched.add(allWords[wi].globalIdx);
  }
  return matched;
}

function findKeyPhraseCluster(allWords: FlatWord[], citTokens: string[]): Set<number> {
  const keys = citTokens.filter((t) => t.length >= 4);
  if (keys.length < 3) return new Set<number>();
  const positions: number[] = [];
  for (let i = 0; i < allWords.length; i++) {
    if (keys.some((k) => allWords[i].norm === k)) positions.push(i);
  }
  if (positions.length < 3) return new Set<number>();
  const windowSize = Math.ceil(citTokens.length * 1.5);
  let bestScore = 0;
  let bestStart = -1;
  let bestEnd = -1;
  for (let i = 0; i < positions.length; i++) {
    let end = i;
    while (end + 1 < positions.length && positions[end + 1] - positions[i] < windowSize) end++;
    const score = end - i + 1;
    if (score > bestScore) {
      bestScore = score;
      bestStart = positions[i];
      bestEnd = positions[end];
    }
  }
  if (bestScore < Math.ceil(keys.length * 0.6)) return new Set<number>();
  const matched = new Set<number>();
  for (let i = bestStart; i <= bestEnd; i++) matched.add(allWords[i].globalIdx);
  return matched;
}

function findAllMatches(ocrData: OcrData, text: string): Set<number> {
  const citNorm = stripTashkeel(text).toLowerCase().trim();
  if (!citNorm) return new Set<number>();
  const citTokens = citNorm
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => stripPunctuation(t))
    .filter(Boolean);
  if (!citTokens.length) return new Set<number>();

  const allWords: FlatWord[] = [];
  let globalIdx = 0;
  for (const page of ocrData.pages) {
    for (let i = 0; i < page.words.length; i++) {
      allWords.push({ norm: normalizeWord(page.words[i].content), globalIdx: globalIdx + i });
    }
    globalIdx += page.words.length;
  }

  let match = findExactConsecutive(allWords, citTokens);
  if (match.size > 0) return match;

  if (citTokens.length >= 3) {
    match = findTolerantWindow(allWords, citTokens);
    if (match.size > 0) return match;
  }

  match = findSubstringMatch(allWords, stripPunctuation(citNorm));
  if (match.size > 0) return match;

  return findKeyPhraseCluster(allWords, citTokens);
}

/* ── PreviewPage ────────────────────────────────────────────── */

function PreviewPage({
  page,
  docId,
  matchIds,
  wordOffset,
}: {
  page: OcrPage;
  docId: string;
  matchIds: Set<number>;
  wordOffset: number;
}) {
  const scaleX = page.rasterWidth > 0 ? page.rasterWidth / page.width : 200;
  const scaleY = page.rasterHeight > 0 ? page.rasterHeight / page.height : 200;
  const pw = page.rasterWidth || Math.round(page.width * 200);
  const ph = page.rasterHeight || Math.round(page.height * 200);

  const regions = useMemo(() => {
    const PAD = 3;
    const LINE_THRESH = 0.5;
    const result: { left: number; top: number; width: number; height: number }[] = [];

    type RectInfo = { rect: { left: number; top: number; width: number; height: number } } | null;
    const tagged: RectInfo[] = [];

    for (let i = 0; i < page.words.length; i++) {
      const w = page.words[i];
      if (w.polygon.length < 8) { tagged.push(null); continue; }
      const rect = polygonToRect(w.polygon, scaleX, scaleY);
      if (rect.width < 1 || rect.height < 1) { tagged.push(null); continue; }
      tagged.push(matchIds.has(wordOffset + i) ? { rect } : null);
    }

    let gLeft = 0, gRight = 0, gTop = 0, gBottom = 0, gStarted = false;
    const flush = () => {
      if (gStarted) {
        result.push({
          left: gLeft - PAD,
          top: gTop - PAD,
          width: gRight - gLeft + PAD * 2,
          height: gBottom - gTop + PAD * 2,
        });
      }
      gStarted = false;
    };

    for (const item of tagged) {
      if (!item) { flush(); continue; }
      const { rect } = item;
      const midY = rect.top + rect.height / 2;
      if (gStarted) {
        const gMidY = (gTop + gBottom) / 2;
        if (Math.abs(midY - gMidY) < (gBottom - gTop) * LINE_THRESH) {
          gLeft = Math.min(gLeft, rect.left);
          gRight = Math.max(gRight, rect.left + rect.width);
          gTop = Math.min(gTop, rect.top);
          gBottom = Math.max(gBottom, rect.top + rect.height);
          continue;
        }
      }
      flush();
      gStarted = true;
      gLeft = rect.left;
      gRight = rect.left + rect.width;
      gTop = rect.top;
      gBottom = rect.top + rect.height;
    }
    flush();

    return result;
  }, [page.words, scaleX, scaleY, matchIds, wordOffset]);

  return (
    <div style={{ margin: "12px auto" }}>
      <div
        style={{
          position: "relative",
          width: pw,
          height: ph,
          margin: "0 auto",
          background: "#fff",
          boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
          overflow: "hidden",
        }}
      >
        <img
          src={`/api/document/${encodeURIComponent(docId)}/page/${page.pageNumber}/image`}
          alt={`Page ${page.pageNumber}`}
          loading={regions.length > 0 ? "eager" : "lazy"}
          width={pw}
          height={ph}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            display: "block",
            userSelect: "none",
            pointerEvents: "none",
          }}
          draggable={false}
        />
        {/* Highlight overlay */}
        <div style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none" }}>
          {regions.map((r, idx) => (
            <div
              key={idx}
              style={{
                position: "absolute",
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height,
                borderRadius: 4,
                pointerEvents: "none",
                background:
                  "linear-gradient(180deg, rgba(155,27,48,0.12) 0%, rgba(155,27,48,0.25) 100%)",
                border: "1.5px solid rgba(155,27,48,0.4)",
                boxShadow: "0 1px 8px rgba(155,27,48,0.18)",
              }}
            />
          ))}
          {/* Invisible markers for scroll targeting */}
          {page.words.map((word, i) => {
            if (word.polygon.length < 8 || !matchIds.has(wordOffset + i)) return null;
            const rect = polygonToRect(word.polygon, scaleX, scaleY);
            return (
              <span
                key={`m-${i}`}
                data-highlight-word="true"
                style={{
                  position: "absolute",
                  left: rect.left,
                  top: rect.top,
                  width: 1,
                  height: 1,
                  overflow: "hidden",
                  pointerEvents: "none",
                }}
              />
            );
          })}
        </div>
      </div>
      <div style={{ textAlign: "center", marginTop: 4, fontSize: 11, color: "#999" }}>
        {page.pageNumber}
      </div>
    </div>
  );
}

/* ── DocumentPreview ────────────────────────────────────────── */

interface DocumentPreviewProps {
  result: SearchResultItem;
  citationIndex: number;
  query: string;
  onClose: () => void;
}

export default function DocumentPreview({
  result,
  citationIndex,
  query,
  onClose,
}: DocumentPreviewProps) {
  const [ocrData, setOcrData] = useState<OcrData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.5);
  const [manualZoom, setManualZoom] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch OCR data
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/document/${encodeURIComponent(result.doc_id)}/ocr`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: OcrData) => {
        if (!cancelled) {
          setOcrData(data);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [result.doc_id]);

  // Match chunk text against OCR words
  const matchIds = useMemo(() => {
    if (!ocrData?.pages?.length) return new Set<number>();
    return findAllMatches(ocrData, result.text);
  }, [ocrData, result.text]);

  // Page word offsets
  const pageWordOffsets = useMemo(() => {
    if (!ocrData?.pages?.length) return [] as number[];
    const offsets: number[] = [];
    let offset = 0;
    for (const page of ocrData.pages) {
      offsets.push(offset);
      offset += page.words.length;
    }
    return offsets;
  }, [ocrData]);

  // Find which pages have highlights — show those + neighbors
  const highlightedPages = useMemo(() => {
    if (!ocrData?.pages?.length || !matchIds.size) return null;
    const pages = new Set<number>();
    let offset = 0;
    for (let pi = 0; pi < ocrData.pages.length; pi++) {
      const page = ocrData.pages[pi];
      for (let wi = 0; wi < page.words.length; wi++) {
        if (matchIds.has(offset + wi)) {
          pages.add(pi);
          break;
        }
      }
      offset += page.words.length;
    }
    const withNeighbors = new Set<number>();
    for (const p of pages) {
      if (p > 0) withNeighbors.add(p - 1);
      withNeighbors.add(p);
      if (p < ocrData.pages.length - 1) withNeighbors.add(p + 1);
    }
    return withNeighbors;
  }, [ocrData, matchIds]);

  // Auto-scroll to first highlighted word
  useEffect(() => {
    if (!matchIds.size || !containerRef.current) return;
    const t = setTimeout(() => {
      const el = containerRef.current?.querySelector("[data-highlight-word]");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 400);
    return () => clearTimeout(t);
  }, [matchIds, ocrData]);

  const docHref = `/document/${result.doc_id}?q=${encodeURIComponent(query)}`;

  useEffect(() => {
    if (!ocrData?.pages?.length || !containerRef.current || manualZoom) return;

    const computeFitZoom = () => {
      const container = containerRef.current;
      if (!container) return;

      const widestPagePx = Math.max(
        ...ocrData.pages.map((page) => page.rasterWidth || Math.round(page.width * 200)),
      );
      if (widestPagePx <= 0) return;

      const targetWidth = Math.min(container.clientWidth * 0.78, 760);
      const fittedZoom = Math.min(0.46, Math.max(0.18, targetWidth / widestPagePx));
      setZoom(Number(fittedZoom.toFixed(3)));
    };

    const frame = window.requestAnimationFrame(computeFitZoom);
    const observer = new ResizeObserver(() => computeFitZoom());
    observer.observe(containerRef.current);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [manualZoom, ocrData]);

  // Determine which pages to show
  const pagesToRender = useMemo(() => {
    return ocrData?.pages
      ?.map((page, i) => ({ page, i }))
      .filter(({ i }) => !highlightedPages || highlightedPages.has(i));
  }, [ocrData, highlightedPages]);

  return (
    <div
      className="sticky top-[105px] flex flex-col rounded-2xl border border-border bg-bg-elevated shadow-sm"
      style={{ maxHeight: "calc(100vh - 120px)" }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2.5">
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-rose-600 text-[11px] font-bold text-white">
          {citationIndex + 1}
        </span>
        <h3
          className="flex-1 truncate font-arabic text-[13px] font-semibold text-text-primary"
          dir="rtl"
        >
          {result.title}
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              setManualZoom(true);
              setZoom((z) => Math.max(0.15, z - 0.05));
            }}
            className="rounded p-1 text-text-muted hover:bg-bg-secondary transition"
          >
            <ZoomOut size={13} />
          </button>
          <span className="min-w-[32px] text-center text-[10px] tabular-nums text-text-muted">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => {
              setManualZoom(true);
              setZoom((z) => Math.min(1.2, z + 0.05));
            }}
            className="rounded p-1 text-text-muted hover:bg-bg-secondary transition"
          >
            <ZoomIn size={13} />
          </button>
        </div>
        <Link
          href={docHref}
          className="flex items-center gap-1 rounded-lg bg-rose-50 px-2 py-1 text-[11px] font-arabic text-rose-600 hover:bg-rose-100 transition"
        >
          <ExternalLink size={11} /> فتح المستند
        </Link>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-text-muted hover:bg-bg-secondary transition"
          title="إغلاق"
        >
          <X size={14} />
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16 gap-2">
          <Loader2 size={18} className="animate-spin text-rose-500" />
          <span className="font-arabic text-sm text-text-muted">
            جاري تحميل المستند...
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-4 text-rose-600">
          <AlertCircle size={14} />
          <p className="font-arabic text-sm">خطأ: {error}</p>
        </div>
      )}

      {/* Pages */}
      {ocrData && !loading && (
        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto overflow-x-auto"
          style={{ background: "#e8e8e8", padding: "8px 0", zoom }}
        >
            {pagesToRender?.map(({ page, i }) => (
              <PreviewPage
                key={page.pageNumber}
                page={page}
                docId={result.doc_id}
                matchIds={matchIds}
                wordOffset={pageWordOffsets[i] ?? 0}
              />
            ))}
            {highlightedPages &&
              ocrData.pages.length > highlightedPages.size && (
                <div className="py-3 text-center">
                  <span className="font-arabic text-[11px] text-text-muted">
                    عرض {highlightedPages.size} من {ocrData.pages.length} صفحة
                  </span>
                </div>
              )}
        </div>
      )}

      {/* No match notice */}
      {ocrData && !loading && !matchIds.size && (
        <div className="border-t border-border-subtle px-4 py-2">
          <p className="font-arabic text-[11px] text-amber-600">
            ⚠ لم يتم تحديد موقع النص في المستند
          </p>
        </div>
      )}
    </div>
  );
}
