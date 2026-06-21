// Pure OCR geometry + Arabic-tolerant citation-matching helpers.
// Extracted verbatim from DocumentViewer.tsx so the matching core can be
// unit-tested in isolation and shared by the HAMISH reading mode (PLAN-04).

export interface OcrWord {
  content: string;
  polygon: number[]; // [x0,y0, x1,y1, x2,y2, x3,y3] in inches
  confidence: number;
}

export interface OcrLine {
  content: string;
  polygon: number[];
}

export interface OcrPage {
  pageNumber: number;
  width: number; // inches
  height: number; // inches
  unit: string;
  angle: number;
  rasterWidth: number; // actual raster pixels
  rasterHeight: number; // actual raster pixels
  words: OcrWord[];
  lines: OcrLine[];
}

export interface OcrData {
  pages: OcrPage[];
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Convert an 8-point polygon to { left, top, width, height } in pixels using actual scale. */
export function polygonToRect(polygon: number[], scaleX: number, scaleY: number): Rect {
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

// Regexes built from code points (pure-ASCII source, no literal combining or
// dash bytes). Identical to the original DocumentViewer ranges:
//   tashkeel: U+0610-U+061A, U+064B-U+065F, U+0670, U+06D6-U+06ED
//   dashes:   U+2013 (en), U+2014 (em)
const cp = (n: number) => String.fromCharCode(n);
const range = (a: number, b: number) => cp(a) + "-" + cp(b);
const TASHKEEL_RE = new RegExp(
  "[" + range(0x0610, 0x061a) + range(0x064b, 0x065f) + cp(0x0670) + range(0x06d6, 0x06ed) + "]",
  "g",
);
const PUNCT_RE = /[.,،؛:؟!()\[\]{}«»"'\-٪%\/\\]/g;
const DASH_RE = new RegExp("[" + cp(0x2013) + cp(0x2014) + "]", "g");

/** Remove Arabic diacritics (tashkeel) for fuzzy matching. */
export function stripTashkeel(s: string): string {
  return s.replace(TASHKEEL_RE, "");
}

/** Strip punctuation OCR often attaches to words (incl. en-dash and em-dash). */
export function stripPunctuation(s: string): string {
  return s.replace(PUNCT_RE, "").replace(DASH_RE, "");
}

/** Full normalization: tashkeel + punctuation + lowercase + trim. */
export function normalizeWord(s: string): string {
  return stripPunctuation(stripTashkeel(s)).toLowerCase().trim();
}

export type FlatWord = { norm: string; globalIdx: number };

/** Strategy 1: exact consecutive word match. Returns the first run found. */
export function findExactConsecutive(allWords: FlatWord[], citTokens: string[]): Set<number> {
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

/** Strategy 2: tolerant window, allow up to 10% mismatched tokens. */
export function findTolerantWindow(allWords: FlatWord[], citTokens: string[]): Set<number> {
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

/** Strategy 3: substring match, join OCR words and find the citation as a substring. */
export function findSubstringMatch(allWords: FlatWord[], citNorm: string): Set<number> {
  // Require minimum citation length to avoid false positives.
  if (citNorm.length < 8) return new Set<number>();

  const charToWord: number[] = [];
  let text = "";
  for (let i = 0; i < allWords.length; i++) {
    if (i > 0) {
      text += " ";
      charToWord.push(-1);
    }
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

/** Strategy 4: key-phrase cluster, find the densest region containing distinctive words. */
export function findKeyPhraseCluster(allWords: FlatWord[], citTokens: string[]): Set<number> {
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

  // Need at least 60% of key tokens matched in the window.
  if (bestScore < Math.ceil(keys.length * 0.6)) return new Set<number>();

  const matched = new Set<number>();
  for (let i = bestStart; i <= bestEnd; i++) matched.add(allWords[i].globalIdx);
  return matched;
}

/** First strong bidi direction of a string (defaults to rtl for Arabic docs). */
export function firstStrongDir(text: string): "rtl" | "ltr" {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x0590 && code <= 0x05ff) || // Hebrew
      (code >= 0x0600 && code <= 0x06ff) || // Arabic
      (code >= 0x0750 && code <= 0x077f) || // Arabic Supplement
      (code >= 0x08a0 && code <= 0x08ff) || // Arabic Extended-A
      (code >= 0xfb50 && code <= 0xfdff) || // Arabic Pres. Forms-A
      (code >= 0xfe70 && code <= 0xfeff) // Arabic Pres. Forms-B
    )
      return "rtl";
    if ((code >= 0x0041 && code <= 0x005a) || (code >= 0x0061 && code <= 0x007a)) return "ltr";
  }
  return "rtl";
}
