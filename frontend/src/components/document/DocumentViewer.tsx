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
  ChevronsUp,
  ChevronsDown,
  MessageSquareText,
  Search,
  X,
  ChevronUp,
  ChevronDown,
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

/** Strip punctuation that OCR often attaches to words. */
function stripPunctuation(s: string) {
  return s.replace(/[.,،؛:؟!()\[\]{}«»"'\-–—٪%\/\\]/g, "");
}

/** Full normalization: tashkeel + punctuation + lowercase + trim. */
function normalizeWord(s: string) {
  return stripPunctuation(stripTashkeel(s)).toLowerCase().trim();
}

/* ── Citation matching strategies ───────────────────────────── */

type FlatWord = { norm: string; globalIdx: number };

/** Strategy 1: Exact consecutive word match */
function findExactConsecutive(allWords: FlatWord[], citTokens: string[]): Set<number> {
  const matched = new Set<number>();
  for (let i = 0; i <= allWords.length - citTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < citTokens.length; j++) {
      if (allWords[i + j].norm !== citTokens[j]) {
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

/** Strategy 2: Tolerant window — allow up to 10% mismatched tokens */
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

/** Strategy 3: Substring match — join OCR words, find the citation as a substring */
function findSubstringMatch(allWords: FlatWord[], citNorm: string): Set<number> {
  // Require minimum citation length to avoid false positives
  if (citNorm.length < 8) return new Set<number>();

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
  // Use only distinctive tokens (length >= 4 chars)
  const keys = citTokens.filter((t) => t.length >= 4);
  if (keys.length < 3) return new Set<number>();

  // Find all positions where key tokens appear
  const positions: number[] = [];
  for (let i = 0; i < allWords.length; i++) {
    if (keys.some((k) => allWords[i].norm === k)) {
      positions.push(i);
    }
  }
  if (positions.length < 3) return new Set<number>();

  // Find the densest window of `keys.length` matches within a window of citTokens.length * 1.5
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

  // Need at least 60% of key tokens matched in window
  if (bestScore < Math.ceil(keys.length * 0.6)) return new Set<number>();

  const matched = new Set<number>();
  for (let i = bestStart; i <= bestEnd; i++) matched.add(allWords[i].globalIdx);
  return matched;
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
  citationMatchIds,
  globalWordOffset,
  pageIndex,
  findMatchIds,
  activeFindIds,
}: {
  page: OcrPage;
  docId: string;
  citationMatchIds: Set<number>;
  globalWordOffset: number;
  pageIndex: number;
  findMatchIds: Set<number>;
  activeFindIds: Set<number>;
}) {
  // Use actual raster dimensions for precise alignment
  const scaleX = page.rasterWidth > 0 ? page.rasterWidth / page.width : 200;
  const scaleY = page.rasterHeight > 0 ? page.rasterHeight / page.height : 200;
  const pageWidthPx = page.rasterWidth || Math.round(page.width * 200);
  const pageHeightPx = page.rasterHeight || Math.round(page.height * 200);
  const textLayerRef = useRef<HTMLDivElement>(null);

  // Compute citation highlight regions by grouping consecutive citation-highlighted words on the same line
  const highlightRegions = useMemo(() => {
    const PAD = 3; // px padding around groups
    const LINE_THRESH = 0.5; // words within 50% height difference = same line
    const regions: { left: number; top: number; width: number; height: number }[] = [];

    type WordInfo = { rect: { left: number; top: number; width: number; height: number } } | null;
    const tagged: WordInfo[] = [];

    for (let i = 0; i < page.words.length; i++) {
      const word = page.words[i];
      if (word.polygon.length < 8) continue;
      const rect = polygonToRect(word.polygon, scaleX, scaleY);
      if (rect.width < 1 || rect.height < 1) continue;

      const isCitation = citationMatchIds.has(globalWordOffset + i);

      if (isCitation) {
        tagged.push({ rect });
      } else {
        tagged.push(null);
      }
    }

    let groupStart = -1;
    let groupTop = 0, groupBottom = 0, groupLeft = 0, groupRight = 0;

    const flushGroup = () => {
      if (groupStart >= 0) {
        regions.push({
          left: groupLeft - PAD,
          top: groupTop - PAD,
          width: groupRight - groupLeft + PAD * 2,
          height: groupBottom - groupTop + PAD * 2,
        });
      }
      groupStart = -1;
    };

    for (let i = 0; i < tagged.length; i++) {
      const item = tagged[i];
      if (!item || !item.rect) {
        flushGroup();
        continue;
      }
      const { rect } = item;
      const midY = rect.top + rect.height / 2;

      if (groupStart >= 0) {
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
      groupLeft = rect.left;
      groupRight = rect.left + rect.width;
      groupTop = rect.top;
      groupBottom = rect.top + rect.height;
    }
    flushGroup();

    return regions;
  }, [page.words, scaleX, scaleY, citationMatchIds, globalWordOffset]);

  // Sort lines by vertical position for correct DOM/selection order
  const sortedLines = useMemo(() => {
    if (!page.lines?.length) return [];
    return [...page.lines]
      .map((line) => {
        if (!line.polygon || line.polygon.length < 8) return null;
        const rect = polygonToRect(line.polygon, scaleX, scaleY);
        if (rect.width < 1 || rect.height < 1) return null;
        return { content: line.content, rect };
      })
      .filter(Boolean)
      .sort((a, b) => a!.rect.top - b!.rect.top) as { content: string; rect: { left: number; top: number; width: number; height: number } }[];
  }, [page.lines, scaleX, scaleY]);

  // After mount, measure each line span and apply scaleX for exact fit
  useEffect(() => {
    const layer = textLayerRef.current;
    if (!layer) return;
    const spans = layer.querySelectorAll<HTMLSpanElement>(".doc-line");
    spans.forEach((el) => {
      const targetW = parseFloat(el.dataset.tw || "0");
      if (targetW <= 0) return;
      el.style.transform = "none";
      el.style.width = "auto";
      const natural = el.scrollWidth;
      if (natural > 0 && targetW > 0) {
        const scale = targetW / natural;
        const capped = Math.max(0.5, Math.min(1.5, scale));
        if (Math.abs(capped - 1) > 0.01) {
          el.style.transform = `scaleX(${capped.toFixed(4)})`;
        }
      }
      el.style.width = `${targetW}px`;
    });
  }, [page, sortedLines]);

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
          width={pageWidthPx}
          height={pageHeightPx}
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

      {/* Highlight overlay – word-level regions (no pointer events) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 2,
          pointerEvents: "none",
        }}
      >
        {highlightRegions.map((r, idx) => {
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
                background: "linear-gradient(180deg, rgba(155,27,48,0.12) 0%, rgba(155,27,48,0.25) 100%)",
                border: "1.5px solid rgba(155,27,48,0.4)",
                boxShadow: "0 1px 8px rgba(155,27,48,0.18)",
              }}
            />
          );
        })}
        {/* Invisible word markers for citation targeting */}
        {page.words.map((word, i) => {
          if (word.polygon.length < 8) return null;
          const isCitation = citationMatchIds.has(globalWordOffset + i);
          if (!isCitation) return null;
          const rect = polygonToRect(word.polygon, scaleX, scaleY);
          return (
            <span
              key={`wm-${i}`}
              data-global-id={globalWordOffset + i}
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
        {/* Find-in-document highlights — per-word amber rects, active match brighter */}
        {(findMatchIds.size > 0) && page.words.map((word, i) => {
          if (word.polygon.length < 8) return null;
          const gid = globalWordOffset + i;
          if (!findMatchIds.has(gid)) return null;
          const isActive = activeFindIds.has(gid);
          const rect = polygonToRect(word.polygon, scaleX, scaleY);
          if (rect.width < 1 || rect.height < 1) return null;
          return (
            <div
              key={`find-${i}`}
              {...(isActive ? { "data-find-active": "1" } : {})}
              style={{
                position: "absolute",
                left: rect.left - 1.5,
                top: rect.top - 1.5,
                width: rect.width + 3,
                height: rect.height + 3,
                borderRadius: 3,
                pointerEvents: "none",
                background: isActive
                  ? "rgba(245,158,11,0.55)"
                  : "rgba(250,204,21,0.32)",
                border: isActive
                  ? "1.5px solid rgba(217,119,6,0.9)"
                  : "1px solid rgba(202,138,4,0.45)",
                boxShadow: isActive ? "0 1px 6px rgba(217,119,6,0.35)" : "none",
              }}
            />
          );
        })}
      </div>

      {/* Text selection layer – line-based spans for clean multi-line select & copy */}
      <div
        ref={textLayerRef}
        dir="rtl"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 3,
          pointerEvents: "none",
        }}
      >
        {sortedLines.map((line, idx) => {
          const dir = firstStrongDir(line.content);
          const fontSize = line.rect.height * 0.75;
          return (
            <span
              key={`ln-${idx}`}
              className="doc-line"
              dir={dir}
              data-tw={line.rect.width.toFixed(1)}
              style={{
                position: "absolute",
                left: line.rect.left,
                top: line.rect.top,
                width: line.rect.width,
                height: line.rect.height,
                fontSize,
                lineHeight: `${line.rect.height}px`,
                fontFamily:
                  "'Traditional Arabic', 'Noto Naskh Arabic', 'Amiri', serif",
                color: "transparent",
                whiteSpace: "pre",
                overflow: "visible",
                pointerEvents: "auto",
                transformOrigin: dir === "rtl" ? "right top" : "left top",
              }}
            >
              {line.content}
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
  analyzing?: boolean;
}

export default function DocumentViewer({ docId, query = "", chatOpen = false, citationText = null, citationKey = 0, onCitationNotFound, onAskAboutSelection, analyzing = false }: DocumentViewerProps) {
  const router = useRouter();
  const [ocrData, setOcrData] = useState<OcrData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(() => {
    if (typeof window === "undefined") return 0.6;
    const saved = localStorage.getItem("doc_viewer_zoom");
    return saved ? parseFloat(saved) : 0.6;
  });
  const containerRef = useRef<HTMLDivElement>(null);

  // Persist zoom to localStorage
  useEffect(() => {
    localStorage.setItem("doc_viewer_zoom", String(zoom));
  }, [zoom]);

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
      // Clamp popup position to viewport bounds
      const popupWidth = 120;
      const popupHeight = 36;
      const x = Math.max(popupWidth / 2, Math.min(window.innerWidth - popupWidth / 2, rect.left + rect.width / 2));
      const y = Math.max(popupHeight + 4, rect.top - 10);
      setSelectionPopup({ text, x, y });
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, []);

  // Build per-page word offsets for citation global indexing
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

  // ── Find in document ─────────────────────────────────────────
  const [findOpen, setFindOpen] = useState(false);
  const [findTerm, setFindTerm] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  // Flat list of all normalized words with their global indices.
  const allFindWords = useMemo(() => {
    if (!ocrData?.pages?.length) return [] as FlatWord[];
    const words: FlatWord[] = [];
    let globalIdx = 0;
    for (const page of ocrData.pages) {
      for (let i = 0; i < page.words.length; i++) {
        words.push({ norm: normalizeWord(page.words[i].content), globalIdx: globalIdx + i });
      }
      globalIdx += page.words.length;
    }
    return words;
  }, [ocrData]);

  // Every occurrence of the find term, as groups of global word indices.
  const findGroups = useMemo(() => {
    const term = stripTashkeel(findTerm).toLowerCase().trim();
    if (!term || allFindWords.length === 0) return [] as number[][];
    const tokens = term.split(/\s+/).map((t) => stripPunctuation(t)).filter(Boolean);
    if (!tokens.length) return [];
    const groups: number[][] = [];
    for (let i = 0; i <= allFindWords.length - tokens.length; i++) {
      let ok = true;
      for (let j = 0; j < tokens.length; j++) {
        // Token matches if the OCR word contains it (handles attached affixes).
        if (!allFindWords[i + j].norm.includes(tokens[j])) {
          ok = false;
          break;
        }
      }
      if (ok) {
        groups.push(allFindWords.slice(i, i + tokens.length).map((w) => w.globalIdx));
        i += tokens.length - 1; // don't overlap matches
      }
    }
    return groups;
  }, [findTerm, allFindWords]);

  const findMatchIds = useMemo(() => {
    const s = new Set<number>();
    for (const g of findGroups) for (const id of g) s.add(id);
    return s;
  }, [findGroups]);

  const activeFindIds = useMemo(() => {
    const g = findGroups[activeMatch];
    return g ? new Set<number>(g) : new Set<number>();
  }, [findGroups, activeMatch]);

  // Scroll the active match into view.
  useEffect(() => {
    if (!findOpen || findGroups.length === 0) return;
    const t = setTimeout(() => {
      const el = containerRef.current?.querySelector("[data-find-active]");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
    return () => clearTimeout(t);
  }, [findOpen, activeMatch, findGroups]);

  const gotoMatch = useCallback(
    (dir: 1 | -1) => {
      setActiveMatch((m) => {
        const n = findGroups.length;
        if (n === 0) return 0;
        return (m + dir + n) % n;
      });
    },
    [findGroups.length],
  );

  // Ctrl/Cmd+F opens the find box; Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
        requestAnimationFrame(() => findInputRef.current?.focus());
      } else if (e.key === "Escape" && findOpen) {
        setFindOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [findOpen]);

  // ── Citation highlighting ────────────────────────────────────
  // Multi-strategy matching: exact consecutive → tolerant (allow skips) → substring
  const citationMatchIds = useMemo(() => {
    if (!citationText || !ocrData?.pages?.length) return new Set<number>();

    const citNorm = stripTashkeel(citationText).toLowerCase().trim();
    if (!citNorm) return new Set<number>();

    // Tokenize citation into words (strip punctuation per token for matching)
    const citTokens = citNorm.split(/\s+/).filter(Boolean).map((t) => stripPunctuation(t)).filter(Boolean);
    if (!citTokens.length) return new Set<number>();

    // Build a flat array of all normalized words with their global indices
    const allWords: { norm: string; globalIdx: number }[] = [];
    let globalIdx = 0;
    for (const page of ocrData.pages) {
      for (let i = 0; i < page.words.length; i++) {
        allWords.push({
          norm: normalizeWord(page.words[i].content),
          globalIdx: globalIdx + i,
        });
      }
      globalIdx += page.words.length;
    }

    // Strategy 1: Exact consecutive match (current approach)
    const exactMatch = findExactConsecutive(allWords, citTokens);
    if (exactMatch.size > 0) return exactMatch;

    // Strategy 2: Tolerant window — allow up to 10% token mismatches (skip if too few tokens)
    if (citTokens.length >= 3) {
      const tolerantMatch = findTolerantWindow(allWords, citTokens);
      if (tolerantMatch.size > 0) return tolerantMatch;
    }

    // Strategy 3: Sliding substring — join OCR words into text, find best overlap
    const citNormNoPunct = stripPunctuation(citNorm);
    const substringMatch = findSubstringMatch(allWords, citNormNoPunct);
    if (substringMatch.size > 0) return substringMatch;

    // Strategy 4: Key-phrase fallback — take distinctive words (length >= 3),
    // find the densest cluster of matches
    const keyPhraseMatch = findKeyPhraseCluster(allWords, citTokens);
    return keyPhraseMatch;
  }, [citationText, ocrData]);

  // Auto-scroll to first citation match
  useEffect(() => {
    if (!citationText) return;
    // Wait for OCR before judging a citation missing — otherwise a deep-linked
    // citation would fire a false "not found" toast before the page text loads.
    if (!ocrData?.pages?.length) return;
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
  }, [citationMatchIds, citationText, citationKey, onCitationNotFound, ocrData]);

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
          <button onClick={zoomOut} className={btnNormal} title="Zoom out" aria-label="تصغير">
            <ZoomOut size={13} />
          </button>
          <span className="min-w-[40px] text-center text-xs text-text-muted tabular-nums" dir="ltr">
            {Math.round(zoom * 100)}%
          </span>
          <button onClick={zoomIn} className={btnNormal} title="Zoom in" aria-label="تكبير">
            <ZoomIn size={13} />
          </button>
          <button onClick={fitPage} className={btnNormal} title="Fit to page" aria-label="ملاءمة الصفحة">
            <Maximize size={13} />
          </button>

          {/* Separator */}
          <div className="h-4 w-px bg-border-subtle" />

          {/* Find in document */}
          <button
            onClick={() => {
              setFindOpen((v) => !v);
              requestAnimationFrame(() => findInputRef.current?.focus());
            }}
            className={findOpen ? `${btnBase} border-accent/40 bg-accent-subtle text-accent` : btnNormal}
            title="بحث في المستند (Ctrl+F)"
            aria-label="بحث في المستند"
            aria-pressed={findOpen}
          >
            <Search size={13} />
          </button>

          {/* Separator */}
          <div className="h-4 w-px bg-border-subtle" />

          {/* Download */}
          <a
            href={`/api/pdf/${docId}`}
            download
            className={`${btnNormal} flex items-center gap-1`}
            title="Download PDF"
            aria-label="تنزيل الملف"
          >
            <Download size={13} />
          </a>

          {/* Page count */}
          <span className="text-[11px] text-text-muted">
            {ocrData.pages.length} page{ocrData.pages.length !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Find bar */}
        {findOpen && (
          <div className="border-t border-border/50 bg-white/95">
            <div className="mx-auto flex h-10 max-w-5xl items-center gap-2 px-5">
              <Search size={14} className="text-text-muted shrink-0" />
              <input
                ref={findInputRef}
                value={findTerm}
                onChange={(e) => {
                  setFindTerm(e.target.value);
                  setActiveMatch(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    gotoMatch(e.shiftKey ? -1 : 1);
                  }
                }}
                placeholder="بحث في المستند…"
                dir="auto"
                className="flex-1 bg-transparent font-arabic text-sm text-text-primary outline-none placeholder:text-text-muted"
              />
              <span className="min-w-[64px] text-center text-xs text-text-muted tabular-nums" dir="ltr">
                {findGroups.length > 0 ? `${activeMatch + 1} / ${findGroups.length}` : findTerm ? "0 / 0" : ""}
              </span>
              <button
                onClick={() => gotoMatch(-1)}
                disabled={findGroups.length === 0}
                className={`${btnNormal} disabled:opacity-40 disabled:cursor-default`}
                title="السابق"
                aria-label="النتيجة السابقة"
              >
                <ChevronUp size={13} />
              </button>
              <button
                onClick={() => gotoMatch(1)}
                disabled={findGroups.length === 0}
                className={`${btnNormal} disabled:opacity-40 disabled:cursor-default`}
                title="التالي"
                aria-label="النتيجة التالية"
              >
                <ChevronDown size={13} />
              </button>
              <button
                onClick={() => setFindOpen(false)}
                className={btnNormal}
                title="إغلاق"
                aria-label="إغلاق البحث"
              >
                <X size={13} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Pages container */}
      <div
        ref={containerRef}
        className="flex-1 relative"
        style={{
          background: "#e8e8e8",
          padding: "24px 0",
          zoom: zoom,
          overflowX: "auto",
        }}
      >
        {/* Analyzing pulse overlay */}
        {analyzing && (
          <div className="absolute inset-0 z-30 pointer-events-none overflow-hidden">
            {/* Soft edge vignette */}
            <div
              className="absolute inset-0"
              style={{
                background: "radial-gradient(ellipse at center, transparent 40%, rgba(155,27,48,0.05) 100%)",
                animation: "analyze-vignette 3s ease-in-out infinite",
              }}
            />
            {/* Circular pulse rings — 3 staggered, expanding from center */}
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="absolute rounded-full"
                style={{
                  top: "50%",
                  left: "50%",
                  width: 0,
                  height: 0,
                  transform: "translate(-50%, -50%)",
                  border: "1.5px solid rgba(155,27,48,0.25)",
                  boxShadow: "0 0 20px 4px rgba(155,27,48,0.06), inset 0 0 20px 4px rgba(155,27,48,0.03)",
                  animation: `analyze-pulse 3.5s cubic-bezier(0.2, 0.6, 0.35, 1) ${i * 1.15}s infinite`,
                }}
              />
            ))}
            {/* Center dot — breathing origin */}
            <div
              className="absolute rounded-full"
              style={{
                top: "50%",
                left: "50%",
                width: 8,
                height: 8,
                transform: "translate(-50%, -50%)",
                background: "rgba(155,27,48,0.35)",
                boxShadow: "0 0 16px 6px rgba(155,27,48,0.15)",
                animation: "analyze-dot 2s ease-in-out infinite",
              }}
            />
            {/* Corner accents */}
            <div className="absolute top-4 left-4 w-8 h-8 border-t-2 border-l-2 border-accent/20 rounded-tl-lg" style={{ animation: "analyze-corner 2s ease-in-out infinite" }} />
            <div className="absolute top-4 right-4 w-8 h-8 border-t-2 border-r-2 border-accent/20 rounded-tr-lg" style={{ animation: "analyze-corner 2s ease-in-out infinite 0.5s" }} />
            <div className="absolute bottom-4 left-4 w-8 h-8 border-b-2 border-l-2 border-accent/20 rounded-bl-lg" style={{ animation: "analyze-corner 2s ease-in-out infinite 1s" }} />
            <div className="absolute bottom-4 right-4 w-8 h-8 border-b-2 border-r-2 border-accent/20 rounded-br-lg" style={{ animation: "analyze-corner 2s ease-in-out infinite 1.5s" }} />
          </div>
        )}

        {ocrData.pages.map((page, i) => (
          <PageView
            key={page.pageNumber}
            page={page}
            docId={docId}
            citationMatchIds={citationMatchIds}
            globalWordOffset={pageWordOffsets[i] ?? 0}
            pageIndex={i}
            findMatchIds={findMatchIds}
            activeFindIds={activeFindIds}
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
          aria-label="التمرير إلى الأعلى"
        >
          <ChevronsUp size={20} className="text-gray-700" />
        </button>
        <button
          onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })}
          className="flex items-center justify-center w-10 h-10 rounded-full bg-white border border-gray-300 shadow-lg cursor-pointer hover:bg-gray-100 hover:scale-110 active:scale-95 transition-all duration-150"
          title="الأسفل"
          aria-label="التمرير إلى الأسفل"
        >
          <ChevronsDown size={20} className="text-gray-700" />
        </button>
      </div>
    </div>
  );
}
