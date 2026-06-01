"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { SlidersHorizontal, X } from "lucide-react";

interface SearchFiltersProps {
  journalId: string;
  section: string;
  docId: string;
  onChange: (filters: { journalId: string; section: string; docId: string }) => void;
}

const SECTIONS = [
  { value: "", label: "جميع الأقسام" },
  { value: "المقدمة", label: "المقدمة" },
  { value: "الإطار_النظري", label: "الإطار النظري" },
  { value: "منهجية_البحث", label: "منهجية البحث" },
  { value: "النتائج", label: "النتائج" },
  { value: "المناقشة", label: "المناقشة" },
  { value: "الخاتمة", label: "الخاتمة" },
  { value: "التوصيات", label: "التوصيات" },
];

export default function SearchFilters({ journalId, section, docId, onChange }: SearchFiltersProps) {
  const [open, setOpen] = useState(false);
  const hasFilters = !!(journalId || section || docId);

  function update(patch: Partial<{ journalId: string; section: string; docId: string }>) {
    onChange({ journalId, section, docId, ...patch });
  }

  function clearAll() {
    onChange({ journalId: "", section: "", docId: "" });
  }

  return (
    <div className="relative">
      {/* Toggle button */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="تصفية النتائج"
        aria-expanded={open}
        className={`
          flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all
          ${hasFilters
            ? "border-accent/30 bg-accent-subtle text-accent"
            : "border-border-subtle bg-bg-secondary text-text-muted hover:text-text-secondary hover:border-border"
          }
        `}
      >
        <SlidersHorizontal size={15} />
        <span className="font-arabic">تصفية</span>
        {hasFilters && (
          <span className="flex h-4.5 w-4.5 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-white">
            {[journalId, section, docId].filter(Boolean).length}
          </span>
        )}
      </button>

      {/* Filter panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.2 }}
            className="absolute start-0 top-full z-30 mt-2 w-80 rounded-2xl border border-border-subtle bg-bg-elevated p-4 shadow-lg"
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-arabic text-sm font-semibold text-text-primary">خيارات التصفية</h3>
              <div className="flex items-center gap-2">
                {hasFilters && (
                  <button
                    onClick={clearAll}
                    className="text-xs text-accent hover:text-accent-hover transition-colors"
                  >
                    مسح الكل
                  </button>
                )}
                <button onClick={() => setOpen(false)} aria-label="إغلاق التصفية" className="text-text-muted hover:text-text-secondary">
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {/* Journal ID */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted font-arabic">
                  رقم المجلة
                </label>
                <input
                  type="text"
                  value={journalId}
                  onChange={(e) => update({ journalId: e.target.value })}
                  placeholder="مثال: 0005"
                  className="w-full rounded-xl border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/50 outline-none focus:border-accent/30 transition-colors"
                  dir="ltr"
                />
              </div>

              {/* Section */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted font-arabic">
                  القسم
                </label>
                <select
                  value={section}
                  onChange={(e) => update({ section: e.target.value })}
                  className="w-full rounded-xl border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/30 transition-colors font-arabic"
                >
                  {SECTIONS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Doc ID */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted font-arabic">
                  معرّف المستند
                </label>
                <input
                  type="text"
                  value={docId}
                  onChange={(e) => update({ docId: e.target.value })}
                  placeholder="مثال: 0005-075-001-002"
                  className="w-full rounded-xl border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/50 outline-none focus:border-accent/30 transition-colors"
                  dir="ltr"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
