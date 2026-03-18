"use client";

import Link from "next/link";
import Image from "next/image";

export default function Header({ compact = false }: { compact?: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/50 bg-white/80 backdrop-blur-xl">
      <div className="mx-auto flex h-13 max-w-5xl items-center justify-between px-5">
        <Link href="/" className="flex items-center gap-1.5 group">
          <Image
            src="/logo_ar.svg"
            alt="المنظومة"
            width={90}
            height={46}
            className="h-7 w-auto"
            priority
          />
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
