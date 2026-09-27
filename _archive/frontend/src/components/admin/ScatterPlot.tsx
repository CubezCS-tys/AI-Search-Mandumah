"use client";

import { useMemo, useState } from "react";
import type { ProjectionPoint } from "@/lib/admin/api";

/* SVG scatter of 2-D PCA-projected vectors, colored by a payload key. */

const PALETTE = [
  "#9B1B30", "#1f6f6f", "#b3791f", "#3b5b9b", "#6b8e23",
  "#8e4585", "#c25b4e", "#2f8f6b", "#a8862a", "#5a5a8e",
  "#7a994d", "#a44a6e", "#4d8fae", "#9a6a3a", "#6f6f6f",
];

export function ScatterPlot({
  points,
  onSelect,
}: {
  points: ProjectionPoint[];
  onSelect?: (p: ProjectionPoint) => void;
}) {
  const [hover, setHover] = useState<{ p: ProjectionPoint; cx: number; cy: number } | null>(null);

  const { colorOf, legend } = useMemo(() => {
    const keys = Array.from(new Set(points.map((p) => p.color_key)));
    keys.sort((a, b) => a.localeCompare(b));
    const map = new Map<string, string>();
    keys.forEach((k, i) => map.set(k, PALETTE[i % PALETTE.length]));
    return {
      colorOf: (k: string) => map.get(k) || "#888",
      legend: keys.slice(0, 14).map((k) => ({ key: k, color: map.get(k)! })),
    };
  }, [points]);

  const W = 640;
  const H = 460;
  const pad = 24;
  // Data is normalized to [-1, 1]; map into the padded viewport.
  const toX = (x: number) => pad + ((x + 1) / 2) * (W - 2 * pad);
  const toY = (y: number) => pad + ((1 - (y + 1) / 2)) * (H - 2 * pad);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-[var(--radius-lg)] border border-border bg-bg-secondary">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          onMouseLeave={() => setHover(null)}
        >
          {/* subtle axes */}
          <line x1={toX(0)} y1={pad} x2={toX(0)} y2={H - pad} stroke="currentColor" className="text-border-subtle" strokeWidth={1} />
          <line x1={pad} y1={toY(0)} x2={W - pad} y2={toY(0)} stroke="currentColor" className="text-border-subtle" strokeWidth={1} />
          {points.map((p) => (
            <circle
              key={p.point_id}
              cx={toX(p.x)}
              cy={toY(p.y)}
              r={hover?.p.point_id === p.point_id ? 5 : 3}
              fill={colorOf(p.color_key)}
              fillOpacity={0.78}
              stroke={hover?.p.point_id === p.point_id ? "var(--text-primary)" : "none"}
              strokeWidth={1}
              className="cursor-pointer transition-all"
              onMouseEnter={() => setHover({ p, cx: toX(p.x), cy: toY(p.y) })}
              onClick={() => onSelect?.(p)}
            />
          ))}
        </svg>
        {hover && (
          <div
            className="pointer-events-none absolute z-10 max-w-[240px] rounded-[var(--radius)] border border-border bg-bg-elevated px-3 py-2 text-[11.5px] shadow-[var(--shadow-md)]"
            style={{
              left: `${(hover.cx / W) * 100}%`,
              top: `${(hover.cy / H) * 100}%`,
              transform: "translate(12px, -50%)",
            }}
          >
            <div className="font-arabic text-text-primary line-clamp-2" dir="auto">
              {hover.p.title || hover.p.doc_id}
            </div>
            <div className="mt-1 text-text-muted">
              {hover.p.color_key} · chunk {hover.p.chunk_index}
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {legend.map((l) => (
          <span key={l.key} className="flex items-center gap-1.5 text-[11.5px] text-text-secondary">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />
            <span className="font-arabic" dir="auto">{l.key}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
