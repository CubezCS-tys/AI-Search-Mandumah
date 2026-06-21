"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { SearchResultItem } from "@/types/search";
import {
  reweight,
  attribution,
  normalizeWeights,
  SIGNAL_LABELS,
  DEFAULT_WEIGHTS,
  type Weights,
} from "@/lib/score/reweight";

// The Score Reactor (PLAN-02): reveals the hybrid score breakdown the engine
// computes then usually hides, and lets the reader reweight the three signals to
// re-rank the RETURNED results live. Honest framing: it is an exploratory lens
// over the returned set, not the engine's true order (it omits rank_prior/penalty).

const PRESETS: { label: string; weights: Weights }[] = [
  { label: "هجين", weights: { dense: 0.5, lexical: 0.3, title: 0.2 } },
  { label: "دلالي", weights: { dense: 1, lexical: 0, title: 0 } },
  { label: "كلمات مفتاحية", weights: { dense: 0, lexical: 1, title: 0 } },
  { label: "العنوان", weights: { dense: 0, lexical: 0, title: 1 } },
];

const BAR_COLORS: Record<keyof Weights, string> = {
  dense: "var(--accent)",
  lexical: "#3c6e71",
  title: "#b07a3c",
};

function pct(x: number): string {
  return Math.round(x * 100) + "%";
}

function WeightSlider({
  signal,
  value,
  onChange,
}: {
  signal: keyof Weights;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="flex items-center justify-between text-xs text-text-secondary">
        <span>{SIGNAL_LABELS[signal]}</span>
        <span dir="ltr" className="tabular-nums text-text-muted">
          {pct(value)}
        </span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="accent-accent"
        style={{ accentColor: BAR_COLORS[signal] }}
        aria-label={SIGNAL_LABELS[signal]}
      />
    </label>
  );
}

function TripleBar({ dense, lexical, title }: { dense: number; lexical: number; title: number }) {
  const total = Math.max(dense + lexical + title, 0.0001);
  const seg = (v: number, key: keyof Weights) => (
    <div
      key={key}
      style={{ width: pct(v / total), background: BAR_COLORS[key] }}
      className="h-full"
      title={SIGNAL_LABELS[key] + " " + pct(v)}
    />
  );
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg-secondary">
      {seg(dense, "dense")}
      {seg(lexical, "lexical")}
      {seg(title, "title")}
    </div>
  );
}

export function ScoreReactor({ results }: { results: SearchResultItem[] }) {
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);

  const ranked = useMemo(() => reweight(results, weights), [results, weights]);
  const blend = normalizeWeights(weights);

  const setOne = (signal: keyof Weights, v: number) => setWeights((w) => ({ ...w, [signal]: v }));

  if (results.length === 0) {
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-elevated p-8 text-center text-text-muted">
        لا توجد نتائج لإعادة ترتيبها.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border-subtle bg-bg-elevated p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="font-heading text-lg text-text-primary">مفاعل الترتيب</span>
          <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-xs text-accent">تجريبي</span>
          <div className="ms-auto flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setWeights(p.weights)}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-text-secondary transition hover:border-accent hover:text-accent"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row">
          {(Object.keys(SIGNAL_LABELS) as (keyof Weights)[]).map((s) => (
            <WeightSlider key={s} signal={s} value={weights[s]} onChange={(v) => setOne(s, v)} />
          ))}
        </div>
        <p className="mt-3 text-xs text-text-muted">
          إعادة ترتيب استكشافية للنتائج المعروضة بمزج إشاراتها الثلاث. لا تعكس ترتيب المحرك الكامل
          (تتجاهل عوامل خفية مثل أولوية الرتبة والعقوبات).
        </p>
      </div>

      <ol className="space-y-2" aria-label="النتائج المُعاد ترتيبها">
        {ranked.map(({ item, parts, blended, rank }) => (
          <motion.li
            layout="position"
            key={item.chunk_id}
            transition={{ type: "spring", stiffness: 500, damping: 40 }}
            className="rounded-xl border border-border-subtle bg-bg-elevated p-4 shadow-sm"
          >
            <div className="flex items-start gap-3">
              <span
                dir="ltr"
                className="mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full bg-accent text-xs font-bold text-white tabular-nums"
              >
                {rank}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="font-arabic text-sm leading-relaxed text-text-primary">{item.title}</h3>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-muted">
                  <span>{item.section}</span>
                  {item.year ? <span dir="ltr">{item.year}هـ</span> : null}
                  {item.authors?.length ? <span>{item.authors.join("، ")}</span> : null}
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <TripleBar dense={parts.denseNorm} lexical={parts.lexical} title={parts.title} />
                  </div>
                  <span dir="ltr" className="flex-none font-bold text-accent tabular-nums">
                    {blended.toFixed(3)}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-text-muted" dir="ltr">
                  <span>{SIGNAL_LABELS.dense} {parts.denseNorm.toFixed(2)}</span>
                  <span>{SIGNAL_LABELS.lexical} {parts.lexical.toFixed(2)}</span>
                  <span>{SIGNAL_LABELS.title} {parts.title.toFixed(2)}</span>
                </div>
                <p className="mt-1.5 text-xs text-text-secondary">{attribution(parts, weights)}</p>
              </div>
            </div>
          </motion.li>
        ))}
      </ol>
      <p className="text-center text-xs text-text-muted" dir="ltr">
        blend: {pct(blend.dense)} {SIGNAL_LABELS.dense} / {pct(blend.lexical)} {SIGNAL_LABELS.lexical} /{" "}
        {pct(blend.title)} {SIGNAL_LABELS.title}
      </p>
    </div>
  );
}
