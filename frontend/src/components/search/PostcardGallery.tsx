"use client";

import { useState } from "react";
import type { SearchResultItem } from "@/types/search";
import { Postcard, type PostcardVariant } from "./Postcard";

// Gallery of shareable Corpus Postcards over the current results (PLAN-05).
// A reachable surface for the Postcard component; the PNG export + the فأل Oracle
// are added on top. Variant cycles so the grid reads as a designed set.

const VARIANTS: PostcardVariant[] = ["paper", "burgundy", "dark"];

export function PostcardGallery({ results }: { results: SearchResultItem[] }) {
  const [base, setBase] = useState(0);

  if (results.length === 0) {
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-elevated p-8 text-center text-text-muted">
        لا توجد نتائج لتصميم بطاقات منها.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-heading text-lg text-text-primary">بطاقات المنظومة</span>
        <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-xs text-accent">قابلة للمشاركة</span>
        <button
          onClick={() => setBase((b) => (b + 1) % VARIANTS.length)}
          className="ms-auto rounded-full border border-border px-3 py-1 text-xs text-text-secondary transition hover:border-accent hover:text-accent"
        >
          بدّل الألوان
        </button>
      </div>
      <p className="text-xs text-text-muted">
        كل نتيجة كبطاقة أنيقة جاهزة للمشاركة. حقول المؤلّف والسنة تظهر متى توفّرت في الفهرسة.
      </p>
      <div className="flex flex-wrap justify-center gap-5">
        {results.slice(0, 6).map((item, i) => (
          <Postcard key={item.chunk_id} item={item} variant={VARIANTS[(base + i) % VARIANTS.length]} />
        ))}
      </div>
    </div>
  );
}
