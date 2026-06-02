"use client";

import { useEffect, useState } from "react";

type Variant = "editorial" | "saas" | "luxe";

const VARIANTS: { id: Variant; label: string; sub: string }[] = [
  { id: "editorial", label: "تحريري", sub: "Editorial" },
  { id: "saas", label: "عصري", sub: "Modern" },
  { id: "luxe", label: "فاخر", sub: "Luxe" },
];

/**
 * Live design-variant switcher. Each variant is a `variant-*` class on
 * <html> that re-skins the whole design-token system (see app/variants/*.css).
 * Initial class is applied pre-paint by the inline script in the root layout;
 * this control flips it live and persists the choice. Temporary decision aid
 * for comparing the three premium directions.
 */
export default function VariantSwitcher() {
  const [variant, setVariant] = useState<Variant | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const el = document.documentElement;
    const current = (["editorial", "saas", "luxe"] as Variant[]).find((v) =>
      el.classList.contains(`variant-${v}`),
    );
    setVariant(current ?? "editorial");
  }, []);

  const pick = (next: Variant) => {
    const el = document.documentElement;
    (["editorial", "saas", "luxe"] as Variant[]).forEach((v) =>
      el.classList.toggle(`variant-${v}`, v === next),
    );
    try {
      localStorage.setItem("ui-variant", next);
    } catch {
      /* storage unavailable — choice just won't persist */
    }
    setVariant(next);
  };

  if (variant === null) return null;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="إظهار مبدّل التصميم"
        className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-full border border-border bg-bg-elevated/90 px-3 py-1.5 text-xs text-text-secondary shadow-lg backdrop-blur transition hover:text-text-primary"
      >
        التصميم
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2"
      dir="rtl"
    >
      <div className="flex items-center gap-1 rounded-full border border-border bg-bg-elevated/90 p-1 shadow-lg backdrop-blur-xl">
        <span className="px-2 text-[10px] font-medium uppercase tracking-wide text-text-muted">
          معاينة
        </span>
        {VARIANTS.map((v) => {
          const active = v.id === variant;
          return (
            <button
              key={v.id}
              onClick={() => pick(v.id)}
              aria-pressed={active}
              className={`flex flex-col items-center rounded-full px-3.5 py-1.5 text-xs transition ${
                active
                  ? "bg-accent text-white shadow-sm"
                  : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
              }`}
            >
              <span className="font-semibold leading-tight">{v.label}</span>
              <span
                dir="ltr"
                className={`text-[9px] leading-tight ${
                  active ? "text-white/70" : "text-text-muted"
                }`}
              >
                {v.sub}
              </span>
            </button>
          );
        })}
        <button
          onClick={() => setOpen(false)}
          aria-label="إخفاء مبدّل التصميم"
          className="ms-1 flex h-6 w-6 items-center justify-center rounded-full text-text-muted transition hover:bg-bg-secondary hover:text-text-primary"
        >
          ×
        </button>
      </div>
    </div>
  );
}
