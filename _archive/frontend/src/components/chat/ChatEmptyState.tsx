"use client";

import { Sparkles, ArrowUpLeft } from "lucide-react";

const EXAMPLE_PROMPTS: string[] = [
  "ما أبرز الاتجاهات البحثية في هذه المجموعة من المقالات؟",
  "قارن بين المناهج المستخدمة في الدراسات حول هذا الموضوع.",
  "لخّص أهم النتائج المتعلقة بالتعليم الإلكتروني.",
  "ما الفجوات البحثية التي تشير إليها هذه المقالات؟",
];

interface ChatEmptyStateProps {
  onPick: (prompt: string) => void;
}

export default function ChatEmptyState({ onPick }: ChatEmptyStateProps) {
  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col items-center justify-center px-4 text-center">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/[0.08]">
        <Sparkles size={26} className="text-accent" />
      </div>
      <h1 className="font-arabic text-[22px] font-bold text-text-primary">
        اسأل مجموعة المقالات
      </h1>
      <p className="mt-2 max-w-md font-arabic text-[14px] leading-relaxed text-text-muted">
        محادثة ذكية عبر كامل مجموعة المقالات الأكاديمية. اطرح سؤالك وستحصل على
        إجابة مدعومة بالمصادر.
      </p>

      <div className="mt-8 grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="group flex items-center justify-between gap-2 rounded-xl border border-border bg-bg-elevated px-4 py-3 text-right transition hover:border-accent/40 hover:bg-accent-subtle"
          >
            <span className="font-arabic text-[13px] leading-relaxed text-text-secondary group-hover:text-text-primary">
              {p}
            </span>
            <ArrowUpLeft
              size={15}
              className="shrink-0 text-text-muted opacity-0 transition group-hover:opacity-100"
            />
          </button>
        ))}
      </div>
    </div>
  );
}
