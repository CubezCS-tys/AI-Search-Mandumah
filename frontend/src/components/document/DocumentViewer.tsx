"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import {
  ZoomIn,
  ZoomOut,
  Maximize,
  Download,
  ArrowRight,
  Highlighter,
  ChevronUp,
  ChevronDown,
  ChevronsUp,
  ChevronsDown,
} from "lucide-react";
import { useRouter } from "next/navigation";

/* ── Types ──────────────────────────────────────────────────────── */

interface OcrWord {
  content: string;
  polygon: number[]; // [x0,y0, x1,y1, x2,y2, x3,y3] in inches
  confidence: number;
}

interface OcrPage {
  pageNumber: number;
  width: number;   // inches
  height: number;  // inches
  unit: string;
  angle: number;
  rasterWidth: number;   // actual raster pixels
  rasterHeight: number;  // actual raster pixels
  words: OcrWord[];
  lines: { content: string; polygon: number[] }[];
}

interface OcrData {
  pages: OcrPage[];
}

/* ── Helpers ────────────────────────────────────────────────────── */

/** Convert 8-point polygon → { left, top, width, height } in pixels using actual scale. */
function polygonToRect(
  polygon: number[],
  scaleX: number,
  scaleY: number,
) {
  const xs = [polygon[0], polygon[2], polygon[4], polygon[6]];
  const ys = [polygon[1], polygon[3], polygon[5], polygon[7]];
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  return {
    left: xMin * scaleX,
    top: yMin * scaleY,
    width: (xMax - xMin) * scaleX,
    height: (yMax - yMin) * scaleY,
  };
}

/** Remove Arabic diacritics (tashkeel) for fuzzy matching. */
function stripTashkeel(s: string) {
  return s.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g, "");
}

/** Check if a word matches any of the search tokens. */
function wordMatchesQuery(word: string, tokens: string[]) {
  if (!tokens.length) return false;
  const normalized = stripTashkeel(word).toLowerCase();
  return tokens.some((t) => normalized.includes(t));
}

/** First strong bidi direction. */
function firstStrongDir(text: string): "rtl" | "ltr" {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    // Arabic/Hebrew ranges → RTL
    if (
      (code >= 0x0590 && code <= 0x05ff) || // Hebrew
      (code >= 0x0600 && code <= 0x06ff) || // Arabic
      (code >= 0x0750 && code <= 0x077f) || // Arabic Supplement
      (code >= 0x08a0 && code <= 0x08ff) || // Arabic Extended-A
      (code >= 0xfb50 && code <= 0xfdff) || // Arabic Pres. Forms-A
      (code >= 0xfe70 && code <= 0xfeff)    // Arabic Pres. Forms-B
    )
      return "rtl";
    // Latin / digits → LTR
    if (
      (code >= 0x0041 && code <= 0x005a) ||
      (code >= 0x0061 && code <= 0x007a)
    )
      return "ltr";
  }
  return "rtl"; // default for Arabic docs
}

/* ── PageView ───────────────────────────────────────────────────── */

function PageView({
  page,
  docId,
  searchTokens,
  highlight,
  activeMatchId,
  matchIdOffset,
  pageIndex,
}: {
  page: OcrPage;
  docId: string;
  searchTokens: string[];
  highlight: boolean;
  activeMatchId: number;
  matchIdOffset: number;
  pageIndex: number;
}) {
  // Use actual raster dimensions for precise alignment
  const scaleX = page.rasterWidth > 0 ? page.rasterWidth / page.width : 200;
  const scaleY = page.rasterHeight > 0 ? page.rasterHeight / page.height : 200;
  const pageWidthPx = page.rasterWidth || Math.round(page.width * 200);
  const pageHeightPx = page.rasterHeight || Math.round(page.height * 200);
  const textLayerRef = useRef<HTMLDivElement>(null);

  // After mount, measure each word span and apply scaleX for exact fit
  useEffect(() => {
    const layer = textLayerRef.current;
    if (!layer) return;
    const spans = layer.querySelectorAll<HTMLSpanElement>(".doc-word");
    spans.forEach((el) => {
      const targetW = parseFloat(el.dataset.tw || "0");
      if (targetW <= 0) return;
      // Reset transform so scrollWidth is natural
      el.style.transform = "none";
      el.style.width = "auto";
      const natural = el.scrollWidth;
      if (natural > 0 && targetW > 0) {
        const scale = targetW / natural;
        // Cap scaleX to prevent severe distortion
        const capped = Math.max(0.7, Math.min(1.3, scale));
        if (Math.abs(capped - 1) > 0.01) {
          el.style.transform = `scaleX(${capped.toFixed(4)})`;
        }
      }
      el.style.width = `${targetW}px`;
    });
  }, [page]);

  return (
    <div style={{ margin: "20px auto" }}>
      <div
        className="doc-page"
        style={{
          position: "relative",
          width: pageWidthPx,
          height: pageHeightPx,
          margin: "0 auto",
          background: "#fff",
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          overflow: "hidden",
        }}
      >
        {/* Page image */}
        <img
          src={`/api/document/${docId}/page/${page.pageNumber}/image`}
          alt={`Page ${page.pageNumber}`}
          loading={pageIndex < 2 ? "eager" : "lazy"}
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

      {/* Text overlay – word-level positioned spans */}
      <div
        ref={textLayerRef}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 2,
          pointerEvents: "none",
        }}
      >
        {page.words.map((word, i) => {
          if (word.polygon.length < 8) return null;
          const rect = polygonToRect(word.polygon, scaleX, scaleY);
          if (rect.width < 1 || rect.height < 1) return null;

          const dir = firstStrongDir(word.content);
          const fontSize = rect.height * 0.75;
          const isMatch = wordMatchesQuery(word.content, searchTokens);
          const matchId = isMatch ? matchIdOffset + i : undefined;
          const isActive = matchId !== undefined && matchId === activeMatchId;

          return (
            <span
              key={i}
              className="doc-word"
              dir={dir}
              data-tw={rect.width.toFixed(1)}
              data-match-id={matchId}
              style={{
                position: "absolute",
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                fontSize,
                lineHeight: `${rect.height}px`,
                fontFamily:
                  "'Traditional Arabic', 'Noto Naskh Arabic', 'Amiri', serif",
                color: "transparent",
                whiteSpace: "pre",
                overflow: "visible",
                pointerEvents: "auto",
                transformOrigin: dir === "rtl" ? "right top" : "left top",
                backgroundColor:
                  highlight && isMatch
                    ? isActive
                      ? "rgba(255, 120, 0, 0.5)"
                      : "rgba(255, 200, 0, 0.35)"
                    : "transparent",
                borderRadius: isMatch ? 2 : 0,
              }}
            >
              {word.content}
            </span>
          );
        })}
        </div>
      </div>
      {/* Page number */}
      <div
        style={{
          textAlign: "center",
          marginTop: 6,
          fontSize: 12,
          color: "#999",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {page.pageNumber}
      </div>
    </div>
  );
}

/* ── DocumentViewer ──────────────────────────────────────────────── */

interface DocumentViewerProps {
  docId: string;
  query?: string;
}

export default function DocumentViewer({ docId, query = "" }: DocumentViewerProps) {
  const router = useRouter();
  const [ocrData, setOcrData] = useState<OcrData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.6);
  const [highlight, setHighlight] = useState(true);
  const [currentMatchIdx, setCurrentMatchIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  // Prepare search tokens
  const searchTokens = useMemo(() => {
    if (!query.trim()) return [];
    return query
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .map((t) => stripTashkeel(t).toLowerCase());
  }, [query]);

  // Build flat list of match IDs: each is pageWordOffset + wordIndex within each page
  const { matchIds, matchOffsets } = useMemo(() => {
    if (!ocrData?.pages?.length || !searchTokens.length)
      return { matchIds: [] as number[], matchOffsets: [] as number[] };

    const ids: number[] = [];
    const offsets: number[] = [];
    let offset = 0;

    for (const page of ocrData.pages) {
      offsets.push(offset);
      page.words.forEach((word, i) => {
        if (wordMatchesQuery(word.content, searchTokens)) {
          ids.push(offset + i);
        }
      });
      offset += page.words.length;
    }

    return { matchIds: ids, matchOffsets: offsets };
  }, [ocrData, searchTokens]);

  // Reset match index when matches change
  useEffect(() => {
    setCurrentMatchIdx(-1);
  }, [matchIds]);

  // Fetch OCR data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/document/${docId}/ocr`)
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

    return () => { cancelled = true; };
  }, [docId]);

  // Auto-fit zoom based on container width and page width
  useEffect(() => {
    if (!ocrData?.pages?.length || !containerRef.current) return;
    const p = ocrData.pages[0];
    const pageWidthPx = p.rasterWidth || Math.round(p.width * 200);
    const containerWidth = containerRef.current.clientWidth - 40; // padding
    if (pageWidthPx > 0) {
      setZoom(Math.min(0.6, containerWidth / pageWidthPx));
    }
  }, [ocrData]);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(3, z + 0.1)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(0.2, z - 0.1)), []);
  const fitPage = useCallback(() => {
    if (!ocrData?.pages?.length || !containerRef.current) return;
    const p = ocrData.pages[0];
    const pageWidthPx = p.rasterWidth || Math.round(p.width * 200);
    const containerWidth = containerRef.current.clientWidth - 40;
    setZoom(Math.min(0.6, containerWidth / pageWidthPx));
  }, [ocrData]);

  const scrollToMatch = useCallback((matchId: number) => {
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-match-id="${matchId}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const goNextMatch = useCallback(() => {
    if (!matchIds.length) return;
    const next = currentMatchIdx < matchIds.length - 1 ? currentMatchIdx + 1 : 0;
    setCurrentMatchIdx(next);
    scrollToMatch(matchIds[next]);
  }, [matchIds, currentMatchIdx, scrollToMatch]);

  const goPrevMatch = useCallback(() => {
    if (!matchIds.length) return;
    const prev = currentMatchIdx > 0 ? currentMatchIdx - 1 : matchIds.length - 1;
    setCurrentMatchIdx(prev);
    scrollToMatch(matchIds[prev]);
  }, [matchIds, currentMatchIdx, scrollToMatch]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        <span className="mr-3 font-arabic text-sm text-text-secondary">
          جاري تحميل المستند...
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center">
        <p className="font-arabic text-sm text-red-400">
          خطأ في تحميل المستند: {error}
        </p>
      </div>
    );
  }

  if (!ocrData?.pages?.length) {
    return (
      <div className="rounded-xl border border-border-subtle bg-bg-elevated p-6 text-center">
        <p className="font-arabic text-sm text-text-muted">لا توجد صفحات</p>
      </div>
    );
  }

  const btnBase =
    "px-2 py-1 rounded text-xs border cursor-pointer transition-colors";
  const btnNormal =
    `${btnBase} bg-white text-text-secondary border-border-subtle hover:bg-gray-50`;
  const btnActive =
    `${btnBase} bg-accent text-white border-accent`;

  return (
    <div className="flex flex-col" style={{ minHeight: "100vh" }}>
      {/* Toolbar — sticks below the Header (h-13 = 3.25rem) */}
      <div
        className="sticky top-13 z-50 border-b border-border/50 bg-white/95 backdrop-blur-sm"
      >
        <div className="mx-auto flex h-10 max-w-5xl items-center gap-4 px-5">
          {/* Back button */}
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 text-sm text-accent hover:underline font-arabic cursor-pointer"
          >
            <ArrowRight size={14} />
            العودة للنتائج
          </button>

          {/* Doc ID */}
          <span className="text-xs text-text-muted" dir="ltr">
            {docId}
          </span>

          {/* Search info */}
          {query && (
            <span className="text-xs text-accent font-arabic">
              بحث: {query}
            </span>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Zoom controls */}
          <button onClick={zoomOut} className={btnNormal} title="Zoom out">
            <ZoomOut size={13} />
          </button>
          <span className="min-w-[40px] text-center text-xs text-text-muted tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <button onClick={zoomIn} className={btnNormal} title="Zoom in">
            <ZoomIn size={13} />
          </button>
          <button onClick={fitPage} className={btnNormal} title="Fit to page">
            <Maximize size={13} />
          </button>

          {/* Separator */}
          <div className="h-4 w-px bg-border-subtle" />

          {/* Highlight toggle + match navigation */}
          {query && (
            <>
              <button
                onClick={() => setHighlight((v) => !v)}
                className={highlight ? btnActive : btnNormal}
                title={highlight ? "إخفاء التظليل" : "إظهار التظليل"}
              >
                <Highlighter size={13} />
              </button>
              {highlight && matchIds.length > 0 && (
                <>
                  <button onClick={goPrevMatch} className={btnNormal} title="النتيجة السابقة">
                    <ChevronUp size={13} />
                  </button>
                  <span className="text-[11px] text-text-muted tabular-nums min-w-[36px] text-center">
                    {currentMatchIdx >= 0 ? currentMatchIdx + 1 : 0}/{matchIds.length}
                  </span>
                  <button onClick={goNextMatch} className={btnNormal} title="النتيجة التالية">
                    <ChevronDown size={13} />
                  </button>
                </>
              )}
            </>
          )}

          {/* Separator */}
          <div className="h-4 w-px bg-border-subtle" />

          {/* Download */}
          <a
            href={`/api/pdf/${docId}`}
            download
            className={`${btnNormal} flex items-center gap-1`}
            title="Download PDF"
          >
            <Download size={13} />
          </a>

          {/* Page count */}
          <span className="text-[11px] text-text-muted">
            {ocrData.pages.length} page{ocrData.pages.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* Pages container */}
      <div
        ref={containerRef}
        className="flex-1"
        style={{
          background: "#e8e8e8",
          padding: "24px 0",
          zoom: zoom,
          overflowX: "auto",
        }}
      >
        {ocrData.pages.map((page, i) => (
          <PageView
            key={page.pageNumber}
            page={page}
            docId={docId}
            searchTokens={searchTokens}
            highlight={highlight}
            activeMatchId={currentMatchIdx >= 0 ? matchIds[currentMatchIdx] : -1}
            matchIdOffset={matchOffsets[i] ?? 0}
            pageIndex={i}
          />
        ))}
      </div>

      {/* Scroll to top / bottom — fixed bottom-right */}
      <div
        className="fixed bottom-5 right-5 z-40 flex flex-col gap-2"
      >
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="flex items-center justify-center w-9 h-9 rounded-full bg-white/90 border border-border-subtle shadow-md cursor-pointer hover:bg-gray-50 transition-colors"
          title="الأعلى"
        >
          <ChevronsUp size={18} className="text-text-secondary" />
        </button>
        <button
          onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })}
          className="flex items-center justify-center w-9 h-9 rounded-full bg-white/90 border border-border-subtle shadow-md cursor-pointer hover:bg-gray-50 transition-colors"
          title="الأسفل"
        >
          <ChevronsDown size={18} className="text-text-secondary" />
        </button>
      </div>
    </div>
  );
}
