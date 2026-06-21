// Pure reweight core for the Score Reactor (PLAN-02). Honest framing: this is an
// EXPLORATORY re-rank of the already-returned results by a user-chosen blend of
// the engine's three exposed sub-signals. It deliberately omits the engine's
// hidden rank_prior/penalty and the post-rerank dedup, so it is a lens, not the
// engine's true order. raw_score is a tiny RRF magnitude (not 0..1), so it is
// min-max normalized across the returned set before blending (mirrors search.py).

export interface ScoreParts {
  raw_score?: number;
  lexical_score?: number;
  title_score?: number;
}

export interface Weights {
  dense: number; // semantic (normalized RRF)
  lexical: number; // keyword overlap
  title: number; // title coverage
}

export interface Normalized {
  denseNorm: number;
  lexical: number;
  title: number;
}

export const DEFAULT_WEIGHTS: Weights = { dense: 0.5, lexical: 0.3, title: 0.2 };

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function denseRange(items: ScoreParts[]): { min: number; max: number } {
  if (items.length === 0) return { min: 0, max: 0 };
  const xs = items.map((i) => i.raw_score ?? 0);
  return { min: Math.min(...xs), max: Math.max(...xs) };
}

export function normalizeParts(item: ScoreParts, range: { min: number; max: number }): Normalized {
  const raw = item.raw_score ?? 0;
  // Mirror the backend guard (search.py:423): when max == min the normalized
  // value is 1.0 (everything ties), not a divide-by-zero.
  const denseNorm = range.max > range.min ? (raw - range.min) / (range.max - range.min) : 1.0;
  return {
    denseNorm,
    lexical: clamp01(item.lexical_score ?? 0),
    title: clamp01(item.title_score ?? 0),
  };
}

export function normalizeWeights(w: Weights): Weights {
  const sum = w.dense + w.lexical + w.title;
  if (sum <= 0) return { dense: 1 / 3, lexical: 1 / 3, title: 1 / 3 };
  return { dense: w.dense / sum, lexical: w.lexical / sum, title: w.title / sum };
}

export function blend(n: Normalized, weights: Weights): number {
  const w = normalizeWeights(weights);
  return w.dense * n.denseNorm + w.lexical * n.lexical + w.title * n.title;
}

export interface Reweighted<T> {
  item: T;
  parts: Normalized;
  blended: number;
  rank: number;
}

/** Re-rank the returned results by a user blend of the 3 exposed signals. */
export function reweight<T extends ScoreParts>(items: T[], weights: Weights): Reweighted<T>[] {
  const range = denseRange(items);
  const scored = items.map((item) => {
    const parts = normalizeParts(item, range);
    return { item, parts, blended: blend(parts, weights) };
  });
  // Stable sort by blended desc (ties keep their original relative order).
  scored.sort((a, b) => b.blended - a.blended);
  return scored.map((s, i) => ({ ...s, rank: i + 1 }));
}

export const SIGNAL_LABELS: Record<keyof Weights, string> = {
  dense: "تطابق دلالي",
  lexical: "تطابق لفظي",
  title: "تطابق العنوان",
};

/** One-line "why did this rank?" attribution from the dominant contributing signal. */
export function attribution(parts: Normalized, weights: Weights): string {
  const w = normalizeWeights(weights);
  const contributions: Array<[keyof Weights, number]> = [
    ["dense", w.dense * parts.denseNorm],
    ["lexical", w.lexical * parts.lexical],
    ["title", w.title * parts.title],
  ];
  contributions.sort((a, b) => b[1] - a[1]);
  return "تصدّرت بفضل " + SIGNAL_LABELS[contributions[0][0]];
}
