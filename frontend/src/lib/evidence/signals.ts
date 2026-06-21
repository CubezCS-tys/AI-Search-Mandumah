// Pure "retrieved-source signals" engine for the Gap & Evidence Console
// (PLAN-03). Honest framing (Codex round-1/2): these are signals derived
// deterministically from the <=N retrieved sources the advanced synthesis
// returned, NOT a field-wide literature review. Every signal cites the exact
// source doc_index values that triggered it; a signal with no supporting doc is
// never emitted. Consensus is quality-weighted (by evidence_quality), not a
// naive stance count.
import type { EvidenceDoc, EvidenceStance } from "@/types/search";
import { stripTashkeel } from "@/lib/ocr/match";

const QUALITY_WEIGHT: Record<string, number> = {
  high: 1.0,
  عالية: 1.0,
  medium: 0.6,
  متوسطة: 0.6,
  low: 0.3,
  محدودة: 0.3,
  منخفضة: 0.3,
};

export function qualityWeight(q?: string): number {
  return QUALITY_WEIGHT[(q ?? "").trim()] ?? 0.6;
}

type StanceKey = EvidenceStance;
const STANCES: StanceKey[] = ["support", "contrast", "mixed", "neutral"];

export interface Consensus {
  total: number;
  counts: Record<StanceKey, number>;
  weighted: Record<StanceKey, number>;
  verdict: string;
}

const STANCE_AR: Record<StanceKey, string> = {
  support: "تؤيد",
  contrast: "تعارض",
  mixed: "مختلطة",
  neutral: "محايدة",
};

/** Quality-weighted stance aggregation across the retrieved sources. */
export function consensus(evidence: EvidenceDoc[]): Consensus {
  const counts: Record<StanceKey, number> = { support: 0, contrast: 0, mixed: 0, neutral: 0 };
  const weighted: Record<StanceKey, number> = { support: 0, contrast: 0, mixed: 0, neutral: 0 };
  for (const e of evidence) {
    const s: StanceKey = e.stance ?? "neutral";
    counts[s] += 1;
    weighted[s] += qualityWeight(e.evidence_quality);
  }
  const total = evidence.length;
  const parts = STANCES.filter((s) => counts[s] > 0).map((s) => counts[s] + " " + STANCE_AR[s]);
  const support = weighted.support;
  const against = weighted.contrast + weighted.mixed;
  let lead = "توافق غير حاسم";
  if (total > 0) {
    // No decisive stances (all neutral/descriptive) -> not "partial agreement".
    if (support === 0 && against === 0) lead = "مصادر وصفية غير حاسمة";
    else if (support > against * 1.5) lead = "توافق على الأثر";
    else if (against > support * 1.5) lead = "تعارض غالب";
    else lead = "توافق جزئي";
  }
  const verdict = total === 0 ? "لا مصادر" : lead + " (" + parts.join("، ") + ")";
  return { total, counts, weighted, verdict };
}

export type SignalType =
  | "contested"
  | "recurring-limitation"
  | "methodological-monoculture"
  | "population-narrowness"
  | "forward-direction";

export interface Signal {
  type: SignalType;
  title: string;
  detail: string;
  /** doc_index values of the sources that triggered this signal (always >= 1). */
  docIndices: number[];
  /** a verbatim quote from a source backing the signal, when one exists. */
  quote?: string;
}

function tokens(s: string): Set<string> {
  return new Set(
    stripTashkeel(s)
      .toLowerCase()
      .split(/[\s،؛.,]+/)
      .filter((t) => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const NARROW_RE =
  /(عيّنة\s+(صغيرة|محدودة)|محدود(ة|ية)\s+العيّنة|مدرسة\s+واحدة|سياق\s+واحد|فصل\s+(دراسي\s+)?واحد)/;

/** Run the deterministic detectors. Capped at `cap` signals, never hallucinated. */
export function deriveSignals(evidence: EvidenceDoc[], cap = 6): Signal[] {
  const out: Signal[] = [];
  if (evidence.length === 0) return out;

  // 1. Contested finding: some sources support, others contrast/mixed.
  const supporters = evidence.filter((e) => e.stance === "support");
  const opposers = evidence.filter((e) => e.stance === "contrast" || e.stance === "mixed");
  if (supporters.length > 0 && opposers.length > 0) {
    out.push({
      type: "contested",
      title: "نتيجة متنازَع عليها",
      detail:
        supporters.length + " مصدر يؤيد الأثر مقابل " + opposers.length + " يعارض أو يراه مختلطًا.",
      docIndices: [...supporters, ...opposers].map((e) => e.doc_index),
    });
  }

  // 2. Recurring limitation: cluster limitation texts by token-Jaccard >= 0.45.
  const lims: { text: string; doc: number; tok: Set<string> }[] = [];
  for (const e of evidence) {
    for (const l of e.limitations ?? []) {
      if (l && l.trim()) lims.push({ text: l.trim(), doc: e.doc_index, tok: tokens(l) });
    }
  }
  const used = new Set<number>();
  for (let i = 0; i < lims.length; i++) {
    if (used.has(i)) continue;
    const cluster = [i];
    for (let j = i + 1; j < lims.length; j++) {
      if (used.has(j)) continue;
      if (lims[i].doc !== lims[j].doc && jaccard(lims[i].tok, lims[j].tok) >= 0.45) cluster.push(j);
    }
    const docs = [...new Set(cluster.map((k) => lims[k].doc))];
    if (docs.length >= 2) {
      cluster.forEach((k) => used.add(k));
      out.push({
        type: "recurring-limitation",
        title: "قيد متكرر",
        detail: "أشار " + docs.length + " مصدر إلى قيد متقارب في التصميم أو القياس.",
        docIndices: docs,
        quote: lims[i].text,
      });
    }
  }

  // 3. Methodological monoculture: one methodology bucket covers >= 70%.
  const withMethod = evidence.filter((e) => (e.methodology ?? "").trim());
  if (withMethod.length >= 3) {
    const buckets = new Map<string, number[]>();
    for (const e of withMethod) {
      const key = stripTashkeel(e.methodology!).toLowerCase().slice(0, 24);
      const arr = buckets.get(key) ?? [];
      arr.push(e.doc_index);
      buckets.set(key, arr);
    }
    for (const [, docs] of buckets) {
      if (docs.length / withMethod.length >= 0.7 && docs.length >= 2) {
        out.push({
          type: "methodological-monoculture",
          title: "أحادية منهجية",
          detail:
            "اعتمد " +
            docs.length +
            " من " +
            withMethod.length +
            " مصدر المنهج نفسه؛ يندر التنويع المنهجي.",
          docIndices: docs,
        });
        break;
      }
    }
  }

  // 4. Population narrowness: sample/limitation text flags a narrow population.
  const narrow = evidence.filter(
    (e) => NARROW_RE.test(e.sample ?? "") || (e.limitations ?? []).some((l) => NARROW_RE.test(l)),
  );
  if (narrow.length >= 2) {
    out.push({
      type: "population-narrowness",
      title: "ضيق العيّنة",
      detail: "نبّه " + narrow.length + " مصدر إلى محدودية حجم العيّنة أو سياقها.",
      docIndices: narrow.map((e) => e.doc_index),
    });
  }

  // 5. Forward direction: surface the implications[] the UI used to drop.
  const fwd = evidence.filter((e) => (e.implications ?? []).length > 0);
  if (fwd.length > 0) {
    const e = fwd[0];
    out.push({
      type: "forward-direction",
      title: "اتجاه مقترح للبحث",
      detail: "تشير المصادر إلى آفاق لم تُبحث بعد.",
      docIndices: fwd.map((d) => d.doc_index),
      quote: e.implications![0],
    });
  }

  return out.slice(0, cap);
}
