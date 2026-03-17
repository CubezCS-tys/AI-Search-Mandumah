"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { ZoomIn, ZoomOut, Maximize, Download } from "lucide-react";

/* ── Types ──────────────────────────────────────────────────────── */

interface OcrWord {
  content: string;
  polygon: number[]; // [x0,y0, x1,y1, x2,y2, x3,y3] in inches
  confidence: number;
}

interface OcrLine {
  content: string;
  polygon: number[];
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
  lines: OcrLine[];
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
  pageIndex,
}: {
  page: OcrPage;
  docId: string;
  searchTokens: string[];
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
    <div
      className="doc-page"
      style={{
        position: "relative",
        width: pageWidthPx,
        height: pageHeightPx,
        margin: "20px auto",
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

          return (
            <span
              key={i}
              className="doc-word"
              dir={dir}
              data-tw={rect.width.toFixed(1)}
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
                // Highlight matching words
                backgroundColor: isMatch
                  ? "rgba(255, 200, 0, 0.35)"
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
  );
}

/* ── DocumentViewer ──────────────────────────────────────────────── */

interface DocumentViewerProps {
  docId: string;
  query?: string;
}

export default function DocumentViewer({ docId, query = "" }: DocumentViewerProps) {
  const [ocrData, setOcrData] = useState<OcrData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);

  // Prepare search tokens
  const searchTokens = useMemo(() => {
    if (!query.trim()) return [];
    return query
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .map((t) => stripTashkeel(t).toLowerCase());
  }, [query]);

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
      setZoom(Math.min(1, containerWidth / pageWidthPx));
    }
  }, [ocrData]);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(3, z + 0.1)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(0.2, z - 0.1)), []);
  const fitPage = useCallback(() => {
    if (!ocrData?.pages?.length || !containerRef.current) return;
    const p = ocrData.pages[0];
    const pageWidthPx = p.rasterWidth || Math.round(p.width * 200);
    const containerWidth = containerRef.current.clientWidth - 40;
    setZoom(Math.min(1, containerWidth / pageWidthPx));
  }, [ocrData]);

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

  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      <div className="sticky top-[100px] z-20 mb-3 flex items-center justify-between rounded-xl border border-border-subtle bg-bg-elevated px-4 py-2 shadow-sm">
        <div className="flex items-center gap-2">
          {query && (
            <span className="font-arabic text-[12px] text-accent">
              يتم تمييز: <span className="font-medium">{query}</span>
            </span>
          )}
          <span className="text-[11px] text-text-muted">
            {ocrData.pages.length} صفحات
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={zoomOut}
            className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-border-subtle hover:text-text-primary"
            title="تصغير"
          >
            <ZoomOut size={15} />
          </button>
          <span className="min-w-[42px] text-center text-[11px] tabular-nums text-text-muted">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={zoomIn}
            className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-border-subtle hover:text-text-primary"
            title="تكبير"
          >
            <ZoomIn size={15} />
          </button>
          <button
            onClick={fitPage}
            className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-border-subtle hover:text-text-primary"
            title="ملائمة"
          >
            <Maximize size={15} />
          </button>
          <div className="mx-1 h-4 w-px bg-border-subtle" />
          <a
            href={`/api/pdf/${docId}`}
            download
            className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-border-subtle hover:text-text-primary"
            title="تحميل PDF"
          >
            <Download size={15} />
          </a>
        </div>
      </div>

      {/* Pages container */}
      <div
        ref={containerRef}
        className="overflow-x-auto rounded-xl border border-border-subtle shadow-sm"
        style={{
          background: "#525659",
          padding: "20px 0",
          zoom: zoom,
        }}
      >
        {ocrData.pages.map((page, i) => (
          <PageView
            key={page.pageNumber}
            page={page}
            docId={docId}
            searchTokens={searchTokens}
            pageIndex={i}
          />
        ))}
      </div>
    </div>
  );
}
