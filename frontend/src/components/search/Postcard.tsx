"use client";

import type { SearchResultItem } from "@/types/search";

// A shareable "corpus postcard" (PLAN-05). Pure presentational card rendered from
// a search hit; the PNG export (html-to-image with embedded Arabic fonts) wraps
// this. Degrades gracefully when MARC fields are null (the prod reality until the
// backfill): falls back to journal_id + doc_id, hides the author line.

export type PostcardVariant = "paper" | "burgundy" | "dark";

const VARIANT: Record<PostcardVariant, { bg: string; ink: string; sub: string; rule: string; accent: string }> = {
  paper: { bg: "#fbfaf7", ink: "#23201c", sub: "#6b6660", rule: "#e6dfd2", accent: "#9B1B30" },
  burgundy: { bg: "#9B1B30", ink: "#fdf3f0", sub: "#f0c9cf", rule: "#bb5566", accent: "#fbfaf7" },
  dark: { bg: "#1a1715", ink: "#eae8e5", sub: "#b8b5ad", rule: "#3a3531", accent: "#d6536a" },
};

// Deterministic dot positions from the doc_id (no Math.random, stable export).
function constellation(seed: string, n = 7): { x: number; y: number; on: boolean }[] {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const pts: { x: number; y: number; on: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    const x = 8 + ((h >>> 8) % 84);
    h = (h * 1103515245 + 12345) >>> 0;
    const y = 8 + ((h >>> 8) % 84);
    pts.push({ x, y, on: i === n - 1 });
  }
  return pts;
}

function authorLine(item: SearchResultItem): string | null {
  if (item.authors && item.authors.length) {
    const head = item.authors.slice(0, 2).join("، ");
    return item.authors.length > 2 ? head + " وآخرون" : head;
  }
  return null;
}

export function Postcard({
  item,
  variant = "paper",
}: {
  item: SearchResultItem;
  variant?: PostcardVariant;
}) {
  const c = VARIANT[variant];
  const authors = authorLine(item);
  const year = item.year ? item.year + "هـ" : null;
  const journal = item.journal ?? null;
  const quote = (item.text ?? "").trim().slice(0, 160);
  const dots = constellation(item.doc_id);

  return (
    <figure
      dir="rtl"
      data-postcard
      className="relative flex flex-col overflow-hidden"
      style={{
        width: 360,
        aspectRatio: "4 / 5",
        background: c.bg,
        color: c.ink,
        padding: 28,
        fontFamily: "var(--font-tajawal), sans-serif",
      }}
    >
      {/* wordmark */}
      <div className="flex items-center justify-between" style={{ color: c.accent }}>
        <span style={{ fontFamily: "var(--font-amiri), serif", fontWeight: 700, fontSize: 20 }}>
          المنظومة <span style={{ fontSize: 14 }}>◈</span>
        </span>
        <span style={{ fontSize: 11, color: c.sub }}>{item.section}</span>
      </div>

      <div style={{ height: 1, background: c.rule, margin: "16px 0" }} />

      {/* title */}
      <h3
        style={{
          fontFamily: "var(--font-amiri), serif",
          fontWeight: 700,
          fontSize: 22,
          lineHeight: 1.5,
          margin: 0,
        }}
      >
        {item.title}
      </h3>

      {/* meta: degrades gracefully */}
      <div style={{ marginTop: 10, fontSize: 12.5, color: c.sub, lineHeight: 1.9 }}>
        {authors && <div>{authors}</div>}
        <div dir="ltr" style={{ direction: "ltr", textAlign: "right" }}>
          {[journal, year, item.journal_id].filter(Boolean).join(" · ")}
        </div>
      </div>

      {/* quote */}
      {quote && (
        <p
          style={{
            marginTop: 16,
            fontSize: 13.5,
            lineHeight: 1.9,
            color: c.ink,
            borderInlineStart: "2px solid " + c.accent,
            paddingInlineStart: 10,
            flex: 1,
          }}
        >
          «{quote}»
        </p>
      )}

      {/* mini-constellation + footer */}
      <div className="flex items-end justify-between" style={{ marginTop: "auto", paddingTop: 14 }}>
        <svg width={64} height={48} viewBox="0 0 100 100" aria-hidden>
          {dots.map((d, i) => (
            <circle
              key={i}
              cx={d.x}
              cy={d.y}
              r={d.on ? 4 : 2}
              fill={d.on ? c.accent : c.sub}
              opacity={d.on ? 1 : 0.5}
            />
          ))}
        </svg>
        <span dir="ltr" style={{ fontSize: 10, color: c.sub, fontFamily: "ui-monospace, monospace" }}>
          {item.doc_id} · al-manzuma
        </span>
      </div>
    </figure>
  );
}
