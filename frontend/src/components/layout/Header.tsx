"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Search, MessageSquare } from "lucide-react";
import HealthIndicator from "./HealthIndicator";

export default function Header({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  const isChat = pathname?.startsWith("/chat");
  const isSearch = pathname?.startsWith("/search");

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

        <nav className="flex items-center gap-1 rounded-full border border-border bg-bg-elevated p-1">
          <Link
            href="/search"
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-arabic font-medium transition ${
              isSearch
                ? "bg-accent text-white"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            <Search size={13} />
            بحث
          </Link>
          <Link
            href="/chat"
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-arabic font-medium transition ${
              isChat
                ? "bg-accent text-white"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            <MessageSquare size={13} />
            محادثة
          </Link>
        </nav>

        <div className="flex items-center gap-3 text-sm">
          <HealthIndicator />
          <span className="rounded-md bg-accent/[0.07] px-2 py-0.5 text-[11px] font-semibold text-accent tracking-wide uppercase">
            Beta
          </span>
        </div>
      </div>
    </header>
  );
}
