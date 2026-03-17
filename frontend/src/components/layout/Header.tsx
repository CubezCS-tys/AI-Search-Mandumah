"use client";

import Link from "next/link";
import { BookOpenText } from "lucide-react";

export default function Header({ compact = false }: { compact?: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/50 bg-white/80 backdrop-blur-xl">
      <div className="mx-auto flex h-13 max-w-5xl items-center justify-between px-5">
        <Link href="/" className="flex items-center gap-2 group">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-white">
            <BookOpenText size={15} />
          </div>
          <span className="font-arabic text-[15px] font-semibold text-text-primary">
            المنظومة
          </span>
        </Link>

        <div className="flex items-center gap-3 text-sm">
          <span className="rounded-md bg-accent/[0.07] px-2 py-0.5 text-[11px] font-semibold text-accent tracking-wide uppercase">
            Beta
          </span>
        </div>
      </div>
    </header>
  );
}
