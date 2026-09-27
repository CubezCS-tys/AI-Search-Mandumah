"use client";

import type { PointDetail } from "@/lib/admin/api";

/* Visualizes a single point's dense + sparse vectors. */

export function DenseVector({ dense }: { dense: NonNullable<PointDetail["dense"]> }) {
  const { preview, dim, norm, min, max } = dense;
  const absMax = Math.max(Math.abs(min), Math.abs(max), 1e-6);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-text-secondary">
        <span>
          dim <b className="tabular-nums text-text-primary">{dim}</b>
        </span>
        <span>
          ‖v‖ <b className="tabular-nums text-text-primary">{norm}</b>
        </span>
        <span>
          min <b className="tabular-nums text-text-primary">{min}</b>
        </span>
        <span>
          max <b className="tabular-nums text-text-primary">{max}</b>
        </span>
      </div>
      {/* Diverging bar strip of the first N dims (positive up, negative down). */}
      <div
        className="flex items-stretch gap-px overflow-hidden rounded-[var(--radius-sm)] border border-border-subtle bg-bg-secondary px-1"
        style={{ height: 72 }}
      >
        {preview.map((v, i) => {
          const h = (Math.abs(v) / absMax) * 50;
          const pos = v >= 0;
          return (
            <div
              key={i}
              className="flex flex-1 flex-col justify-center"
              title={`dim ${i}: ${v}`}
              style={{ minWidth: 2 }}
            >
              <div className="flex h-1/2 items-end">
                {pos && <div className="w-full bg-accent/80" style={{ height: `${h}%` }} />}
              </div>
              <div className="flex h-1/2 items-start">
                {!pos && (
                  <div className="w-full bg-text-muted/60" style={{ height: `${h}%` }} />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-text-muted">
        First {preview.length} of {dim} dimensions · accent = positive, grey = negative
      </p>
    </div>
  );
}

export function SparseVector({ sparse }: { sparse: NonNullable<PointDetail["sparse"]> }) {
  const max = Math.max(...sparse.top_terms.map((t) => t.value), 1e-6);
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12px] text-text-secondary">
        non-zero terms <b className="tabular-nums text-text-primary">{sparse.nnz}</b> · showing top{" "}
        {sparse.top_terms.length}
      </div>
      <div className="flex flex-col gap-1.5">
        {sparse.top_terms.map((t) => (
          <div key={t.index} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-right font-mono text-[11px] text-text-muted">
              #{t.index}
            </span>
            <div className="relative h-4 flex-1 overflow-hidden rounded-[var(--radius-sm)] bg-bg-secondary">
              <div
                className="h-full rounded-[var(--radius-sm)] bg-accent/70"
                style={{ width: `${(t.value / max) * 100}%` }}
              />
            </div>
            <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-text-secondary">
              {t.value.toFixed(3)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
