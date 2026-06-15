"use client";

/* Lightweight dependency-free charts (CSS bars). */

export function BarList({
  data,
  emptyLabel = "No data",
}: {
  data: { value: string; count: number }[];
  emptyLabel?: string;
}) {
  if (!data.length) {
    return <p className="py-4 text-sm text-text-muted">{emptyLabel}</p>;
  }
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <div className="flex flex-col gap-2">
      {data.map((d) => (
        <div key={d.value} className="flex items-center gap-3">
          <span
            className="w-40 shrink-0 truncate text-[12.5px] text-text-secondary font-arabic"
            title={d.value}
            dir="auto"
          >
            {d.value || "—"}
          </span>
          <div className="relative h-5 flex-1 overflow-hidden rounded-[var(--radius-sm)] bg-bg-secondary">
            <div
              className="h-full rounded-[var(--radius-sm)] bg-accent/75"
              style={{ width: `${(d.count / max) * 100}%` }}
            />
          </div>
          <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-text-muted">
            {d.count.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Histogram({ data }: { data: { label: string; count: number }[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <div className="flex items-end gap-2" style={{ height: 140 }}>
      {data.map((d) => (
        <div key={d.label} className="flex flex-1 flex-col items-center gap-1.5">
          <span className="text-[11px] tabular-nums text-text-muted">{d.count || ""}</span>
          <div className="flex w-full flex-1 items-end">
            <div
              className="w-full rounded-t-[var(--radius-sm)] bg-accent/70 transition-all"
              style={{ height: `${(d.count / max) * 100}%`, minHeight: d.count ? 3 : 0 }}
              title={`${d.label}: ${d.count}`}
            />
          </div>
          <span className="text-[10.5px] text-text-secondary">{d.label}</span>
        </div>
      ))}
    </div>
  );
}
