"use client";

import { useMemo, useState } from "react";
import type { EvidenceDoc, EvidenceStance } from "@/types/search";
import { consensus, deriveSignals, qualityWeight, type Signal } from "@/lib/evidence/signals";

// The Gap & Evidence Console (PLAN-03): a quality-weighted consensus meter, a
// derived "retrieved-source signals" list (each citing its sources), and a
// methodology comparator. Honest framing: signals are over the <=N retrieved
// sources, not a field-wide review.

const STANCE_COLOR: Record<EvidenceStance, string> = {
  support: "#2a7a4f",
  contrast: "var(--accent)",
  mixed: "#b5793c",
  neutral: "#9a938b",
};
const STANCE_LABEL: Record<EvidenceStance, string> = {
  support: "مؤيّد",
  contrast: "معارض",
  mixed: "مختلط",
  neutral: "محايد",
};
const STANCES: EvidenceStance[] = ["support", "mixed", "contrast", "neutral"];
const EMPTY = "-";

const SIGNAL_ICON: Record<Signal["type"], string> = {
  contested: "⚖",
  "recurring-limitation": "↻",
  "methodological-monoculture": "◈",
  "population-narrowness": "○",
  "forward-direction": "✦",
};

function ConsensusMeter({ evidence }: { evidence: EvidenceDoc[] }) {
  const c = useMemo(() => consensus(evidence), [evidence]);
  const totalWeight = STANCES.reduce((s, k) => s + c.weighted[k], 0) || 1;
  return (
    <div className="rounded-xl border border-border-subtle bg-bg-elevated p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-heading text-base text-text-primary">ميزان التوافق</span>
        <span className="text-xs text-text-muted">{c.verdict}</span>
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-bg-secondary" role="img" aria-label={c.verdict}>
        {STANCES.filter((k) => c.weighted[k] > 0).map((k) => (
          <div
            key={k}
            style={{ width: Math.round((c.weighted[k] / totalWeight) * 100) + "%", background: STANCE_COLOR[k] }}
            title={STANCE_LABEL[k] + " " + c.counts[k]}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
        {STANCES.filter((k) => c.counts[k] > 0).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: STANCE_COLOR[k] }} />
            {STANCE_LABEL[k]} <span dir="ltr" className="tabular-nums">{c.counts[k]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function SignalCard({ signal, evidence }: { signal: Signal; evidence: EvidenceDoc[] }) {
  const titleFor = (idx: number) => evidence.find((e) => e.doc_index === idx)?.title;
  return (
    <li className="rounded-xl border border-border-subtle bg-bg-elevated p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-accent" aria-hidden>{SIGNAL_ICON[signal.type]}</span>
        <div className="min-w-0 flex-1">
          <h4 className="font-arabic text-sm font-medium text-text-primary">{signal.title}</h4>
          <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">{signal.detail}</p>
          {signal.quote ? (
            <p className="mt-1.5 border-s-2 border-accent ps-2 text-xs text-text-muted">«{signal.quote}»</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1">
            {signal.docIndices.map((idx) => (
              <span
                key={idx}
                className="rounded-full bg-bg-secondary px-2 py-0.5 text-[11px] text-text-muted"
                title={titleFor(idx) ?? ""}
              >
                المصدر <span dir="ltr">{idx}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </li>
  );
}

function MethodologyTable({ evidence }: { evidence: EvidenceDoc[] }) {
  const [sortByQuality, setSortByQuality] = useState(false);
  const rows = useMemo(() => {
    const r = [...evidence];
    if (sortByQuality) r.sort((a, b) => qualityWeight(b.evidence_quality) - qualityWeight(a.evidence_quality));
    return r;
  }, [evidence, sortByQuality]);
  return (
    <div className="overflow-x-auto rounded-xl border border-border-subtle bg-bg-elevated">
      <table className="w-full text-right text-xs">
        <thead className="border-b border-border-subtle text-text-muted">
          <tr>
            <th className="p-2.5 font-medium">المصدر</th>
            <th className="p-2.5 font-medium">المنهج</th>
            <th className="p-2.5 font-medium">العيّنة</th>
            <th className="cursor-pointer p-2.5 font-medium" onClick={() => setSortByQuality((s) => !s)}>
              جودة الأدلة {sortByQuality ? "▼" : ""}
            </th>
            <th className="p-2.5 font-medium">الموقف</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.doc_index} className="border-b border-border-subtle/60 last:border-0">
              <td className="max-w-[14rem] truncate p-2.5 text-text-primary" title={e.title}>{e.title ?? EMPTY}</td>
              <td className="p-2.5 text-text-secondary">{e.methodology ?? EMPTY}</td>
              <td className="p-2.5 text-text-secondary">{e.sample ?? EMPTY}</td>
              <td className="p-2.5 text-text-secondary">{e.evidence_quality ?? EMPTY}</td>
              <td className="p-2.5">
                <span
                  className="rounded-full px-2 py-0.5 text-[11px] text-white"
                  style={{ background: STANCE_COLOR[e.stance ?? "neutral"] }}
                >
                  {STANCE_LABEL[e.stance ?? "neutral"]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EvidenceConsole({ evidence }: { evidence: EvidenceDoc[] }) {
  const signals = useMemo(() => deriveSignals(evidence), [evidence]);

  if (evidence.length === 0) {
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-elevated p-8 text-center text-text-muted">
        لا توجد أدلة مهيكلة بعد. شغّل التوليف المتقدم لاستخراجها.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-text-muted">
        إشارات مُستخرَجة من {evidence.length} مصدرًا مُسترجَعًا (ليست مراجعة شاملة للأدبيات).
      </p>
      <ConsensusMeter evidence={evidence} />

      <div>
        <h3 className="mb-2 font-heading text-base text-text-primary">الإشارات البحثية</h3>
        {signals.length > 0 ? (
          <ul className="space-y-2">
            {signals.map((s, i) => (
              <SignalCard key={s.type + i} signal={s} evidence={evidence} />
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-border-subtle bg-bg-elevated p-4 text-center text-xs text-text-muted">
            لم تظهر إشارات واضحة من هذه المصادر.
          </p>
        )}
      </div>

      <div>
        <h3 className="mb-2 font-heading text-base text-text-primary">مقارنة المناهج</h3>
        <MethodologyTable evidence={evidence} />
      </div>
    </div>
  );
}
