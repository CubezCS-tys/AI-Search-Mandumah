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
  MessageSquareText,
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

/* ── Citation matching strategies ───────────────────────────── */

type FlatWord = { norm: string; globalIdx: number };

/** Strategy 1: Exact consecutive word match */
function findExactConsecutive(allWords: FlatWord[], citTokens: string[]): Set<number> {
  const matched = new Set<number>();
  for (let i = 0; i <= allWords.length - citTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < citTokens.length; j++) {
      if (!allWords[i + j].norm.includes(citTokens[j])) {
        ok = false;
        break;
      }
    }
    if (ok) {
      for (let j = 0; j < citTokens.length; j++) matched.add(allWords[i + j].globalIdx);
      return matched; // first match is enough
    }
  }
  return matched;
}

/** Strategy 2: Tolerant window — allow up to 20% mismatched tokens */
function findTolerantWindow(allWords: FlatWord[], citTokens: string[]): Set<number> {
  const maxMiss = Math.max(1, Math.floor(citTokens.length * 0.2));
  let bestStart = -1;
  let bestMisses = citTokens.length + 1;

  for (let i = 0; i <= allWords.length - citTokens.length; i++) {
    let misses = 0;
    for (let j = 0; j < citTokens.length; j++) {
      if (!allWords[i + j].norm.includes(citTokens[j])) {
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

/** Strategy 3: Substring match — join OCR words, find the citation as a substring */
function findSubstringMatch(allWords: FlatWord[], citNorm: string): Set<number> {
  // Build a running concatenation, track which characters belong to which word
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

/** Strategy 4: Key-phrase cluster — find densest region containing distinctive words */
function findKeyPhraseCluster(allWords: FlatWord[], citTokens: string[]): Set<number> {
  // Use only distinctive tokens (length >= 3 chars)
  const keys = citTokens.filter((t) => t.length >= 3);
  if (keys.length < 2) return new Set<number>();

  // Find all positions where key tokens appear
  const positions: number[] = [];
  for (let i = 0; i < allWords.length; i++) {
    if (keys.some((k) => allWords[i].norm.includes(k))) {
      positions.push(i);
    }
  }
  if (positions.length < 2) return new Set<number>();

  // Find the densest window of `keys.length` matches within a window of citTokens.length * 2
  const windowSize = citTokens.length * 2;
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

  // Need at least 40% of key tokens matched in window
  if (bestScore < Math.ceil(keys.length * 0.4)) return new Set<number>();

  const matched = new Set<number>();
  for (let i = bestStart; i <= bestEnd; i++) matched.add(allWords[i].globalIdx);
  return matched;
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
  citationMatchIds,
  globalWordOffset,
  pageIndex,
}: {
  page: OcrPage;
  docId: string;
  searchTokens: string[];
  highlight: boolean;
  activeMatchId: number;
  matchIdOffset: number;
  citationMatchIds: Set<number>;
  globalWordOffset: number;
  pageIndex: number;
}) {
  // Use actual raster dimensions for precise alignment
  const scaleX = page.rasterWidth > 0 ? page.rasterWidth / page.width : 200;
  const scaleY = page.rasterHeight > 0 ? page.rasterHeight / page.height : 200;
  const pageWidthPx = page.rasterWidth || Math.round(page.width * 200);
  const pageHeightPx = page.rasterHeight || Math.round(page.height * 200);
  const textLayerRef = useRef<HTMLDivElement>(null);

  // Compute unified highlight regions by grouping consecutive same-type highlighted words on the same line
  const highlightRegions = useMemo(() => {
    const PAD = 3; // px padding around groups
    const LINE_THRESH = 0.5; // words within 50% height difference = same line
    const regions: { left: number; top: number; width: number; height: number; type: "citation" | "active" | "match" }[] = [];

    type WordInfo = { rect: { left: number; top: number; width: number; height: number }; type: "citation" | "active" | "match" };
    const tagged: WordInfo[] = [];

    for (let i = 0; i < page.words.length; i++) {
      const word = page.words[i];
      if (word.polygon.length < 8) continue;
      const rect = polygonToRect(word.polygon, scaleX, scaleY);
      if (rect.width < 1 || rect.height < 1) continue;

      const isCitation = citationMatchIds.has(globalWordOffset + i);
      const isMatch = wordMatchesQuery(word.content, searchTokens);
      const matchId = isMatch ? matchIdOffset + i : undefined;
      const isActive = matchId !== undefined && matchId === activeMatchId;

      if (isCitation) {
        tagged.push({ rect, type: "citation" });
      } else if (highlight && isMatch) {
        tagged.push({ rect, type: isActive ? "active" : "match" });
      } else {
        tagged.push(null as unknown as WordInfo); // placeholder
      }
    }

    let groupStart = -1;
    let groupType: "citation" | "active" | "match" | null = null;
    let groupTop = 0, groupBottom = 0, groupLeft = 0, groupRight = 0;

    const flushGroup = () => {
      if (groupStart >= 0 && groupType) {
        regions.push({
          left: groupLeft - PAD,
          top: groupTop - PAD,
          width: groupRight - groupLeft + PAD * 2,
          height: groupBottom - groupTop + PAD * 2,
          type: groupType,
        });
      }
      groupStart = -1;
      groupType = null;
    };

    for (let i = 0; i < tagged.length; i++) {
      const item = tagged[i];
      if (!item || !item.rect) {
        flushGroup();
        continue;
      }
      const { rect, type } = item;
      const midY = rect.top + rect.height / 2;

      if (groupStart >= 0 && groupType === type) {
        // Check if same line (vertical overlap)
        const groupMidY = (groupTop + groupBottom) / 2;
        const groupH = groupBottom - groupTop;
        if (Math.abs(midY - groupMidY) < groupH * LINE_THRESH) {
          // Extend group
          groupLeft = Math.min(groupLeft, rect.left);
          groupRight = Math.max(groupRight, rect.left + rect.width);
          groupTop = Math.min(groupTop, rect.top);
          groupBottom = Math.max(groupBottom, rect.top + rect.height);
          continue;
        }
      }
      // New group
      flushGroup();
      groupStart = i;
      groupType = type;
      groupLeft = rect.left;
      groupRight = rect.left + rect.width;
      groupTop = rect.top;
      groupBottom = rect.top + rect.height;
    }
    flushGroup();

    return regions;
  }, [page.words, scaleX, scaleY, citationMatchIds, globalWordOffset, searchTokens, highlight, activeMatchId, matchIdOffset]);

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
        {/* Unified highlight regions */}
        {highlightRegions.map((r, idx) => {
          const styles: React.CSSProperties =
            r.type === "citation"
              ? {
                  background: "linear-gradient(180deg, rgba(155,27,48,0.12) 0%, rgba(155,27,48,0.25) 100%)",
                  border: "1.5px solid rgba(155,27,48,0.4)",
                  boxShadow: "0 1px 8px rgba(155,27,48,0.18)",
                }
              : r.type === "active"
                ? {
                    background: "linear-gradient(180deg, rgba(255,140,0,0.15) 0%, rgba(255,140,0,0.28) 100%)",
                    border: "1.5px solid rgba(255,140,0,0.4)",
                    boxShadow: "0 1px 6px rgba(255,140,0,0.2)",
                  }
                : {
                    background: "linear-gradient(180deg, rgba(255,200,0,0.1) 0%, rgba(255,200,0,0.22) 100%)",
                    border: "1.5px solid rgba(255,180,0,0.35)",
                  };
          return (
            <div
              key={`hl-${idx}`}
              style={{
                position: "absolute",
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height,
                borderRadius: 4,
                pointerEvents: "none",
                transition: "opacity 0.3s",
                ...styles,
              }}
            />
          );
        })}
        {page.words.map((word, i) => {
          if (word.polygon.length < 8) return null;
          const rect = polygonToRect(word.polygon, scaleX, scaleY);
          if (rect.width < 1 || rect.height < 1) return null;

          const dir = firstStrongDir(word.content);
          const fontSize = rect.height * 0.75;
          const isMatch = wordMatchesQuery(word.content, searchTokens);
          const matchId = isMatch ? matchIdOffset + i : undefined;

          return (
            <span
              key={i}
              className="doc-word"
              dir={dir}
              data-tw={rect.width.toFixed(1)}
              data-match-id={matchId}
              data-global-id={globalWordOffset + i}
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
  chatOpen?: boolean;
  citationText?: string | null;
  citationKey?: number;
  onCitationNotFound?: () => void;
  onAskAboutSelection?: (text: string) => void;
}

export default function DocumentViewer({ docId, query = "", chatOpen = false, citationText = null, citationKey = 0, onCitationNotFound, onAskAboutSelection }: DocumentViewerProps) {
  const router = useRouter();
  const [ocrData, setOcrData] = useState<OcrData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.6);
  const [highlight, setHighlight] = useState(true);
  const [currentMatchIdx, setCurrentMatchIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  // Text selection for "ask about this" feature
  const [selectionPopup, setSelectionPopup] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
        setSelectionPopup(null);
        return;
      }
      const text = selection.toString().trim();
      if (text.length < 3 || text.length > 2000) {
        setSelectionPopup(null);
        return;
      }
      // Only show if selection is inside our container
      const anchor = selection.anchorNode;
      if (!anchor || !containerRef.current?.contains(anchor)) {
        setSelectionPopup(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      setSelectionPopup({ text, x: rect.left + rect.width / 2, y: rect.top - 10 });
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, []);

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

  // ── Citation highlighting ────────────────────────────────────
  // Multi-strategy matching: exact consecutive → tolerant (allow skips) → substring
  const citationMatchIds = useMemo(() => {
    if (!citationText || !ocrData?.pages?.length) return new Set<number>();

    const citNorm = stripTashkeel(citationText).toLowerCase().trim();
    if (!citNorm) return new Set<number>();

    // Tokenize citation into words
    const citTokens = citNorm.split(/\s+/).filter(Boolean);
    if (!citTokens.length) return new Set<number>();

    // Build a flat array of all normalized words with their global indices
    const allWords: { norm: string; globalIdx: number }[] = [];
    let globalIdx = 0;
    for (const page of ocrData.pages) {
      for (let i = 0; i < page.words.length; i++) {
        allWords.push({
          norm: stripTashkeel(page.words[i].content).toLowerCase(),
          globalIdx: globalIdx + i,
        });
      }
      globalIdx += page.words.length;
    }

    // Strategy 1: Exact consecutive match (current approach)
    const exactMatch = findExactConsecutive(allWords, citTokens);
    if (exactMatch.size > 0) return exactMatch;

    // Strategy 2: Tolerant window — allow up to 20% token mismatches
    const tolerantMatch = findTolerantWindow(allWords, citTokens);
    if (tolerantMatch.size > 0) return tolerantMatch;

    // Strategy 3: Sliding substring — join OCR words into text, find best overlap
    const substringMatch = findSubstringMatch(allWords, citNorm);
    if (substringMatch.size > 0) return substringMatch;

    // Strategy 4: Key-phrase fallback — take distinctive words (length >= 3),
    // find the densest cluster of matches
    const keyPhraseMatch = findKeyPhraseCluster(allWords, citTokens);
    return keyPhraseMatch;
  }, [citationText, ocrData]);

  // Auto-scroll to first citation match
  useEffect(() => {
    if (!citationText) return;
    if (!citationMatchIds.size) {
      onCitationNotFound?.();
      return;
    }
    if (!containerRef.current) return;
    const firstId = citationMatchIds.values().next().value;
    const t = setTimeout(() => {
      const el = containerRef.current?.querySelector(`[data-global-id="${firstId}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    return () => clearTimeout(t);
  }, [citationMatchIds, citationText, citationKey, onCitationNotFound]);

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
            citationMatchIds={citationMatchIds}
            globalWordOffset={matchOffsets[i] ?? 0}
            pageIndex={i}
          />
        ))}
      </div>

      {/* "Ask about this" selection popup */}
      {selectionPopup && onAskAboutSelection && (
        <button
          className="fixed z-[70] flex items-center gap-1.5 rounded-lg bg-accent text-white px-3 py-1.5 text-xs font-arabic shadow-lg hover:bg-accent-hover active:scale-95 transition-all cursor-pointer"
          style={{
            left: selectionPopup.x,
            top: selectionPopup.y,
            transform: "translate(-50%, -100%)",
          }}
          onMouseDown={(e) => {
            e.preventDefault(); // prevent selection from clearing
            onAskAboutSelection(selectionPopup.text);
            setSelectionPopup(null);
            window.getSelection()?.removeAllRanges();
          }}
        >
          <MessageSquareText size={13} />
          اسأل عن هذا
        </button>
      )}

      {/* Scroll to top / bottom */}
      <div
        className="fixed z-[60] flex flex-col gap-2 transition-all duration-500"
        style={{ top: 100, right: chatOpen ? "calc(45% + 8px)" : 8 }}
      >
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="flex items-center justify-center w-10 h-10 rounded-full bg-white border border-gray-300 shadow-lg cursor-pointer hover:bg-gray-100 hover:scale-110 active:scale-95 transition-all duration-150"
          title="الأعلى"
        >
          <ChevronsUp size={20} className="text-gray-700" />
        </button>
        <button
          onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })}
          className="flex items-center justify-center w-10 h-10 rounded-full bg-white border border-gray-300 shadow-lg cursor-pointer hover:bg-gray-100 hover:scale-110 active:scale-95 transition-all duration-150"
          title="الأسفل"
        >
          <ChevronsDown size={20} className="text-gray-700" />
        </button>
      </div>
    </div>
  );
}
