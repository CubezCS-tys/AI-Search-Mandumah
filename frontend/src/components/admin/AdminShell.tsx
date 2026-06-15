"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import {
  LayoutDashboard,
  FileText,
  FlaskConical,
  Database,
  LogOut,
  ChevronDown,
} from "lucide-react";
import { fetchCollections } from "@/lib/admin/api";
import { useCollection } from "@/lib/admin/useCollection";
import { clearSession, getUsername } from "@/lib/admin/auth";

const NAV = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/admin/documents", label: "Documents", icon: FileText },
  { href: "/admin/explore", label: "Explore", icon: FlaskConical },
];

function CollectionSwitcher() {
  const { data } = useSWR("admin/collections", fetchCollections, { revalidateOnFocus: false });
  const { collection, setCollection } = useCollection();
  const cols = data?.collections || [];

  return (
    <div className="relative">
      <Database
        size={13}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
      />
      <ChevronDown
        size={13}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted"
      />
      <select
        value={collection || ""}
        onChange={(e) => setCollection(e.target.value)}
        className="w-full appearance-none rounded-[var(--radius)] border border-border bg-bg-elevated py-2 pl-8 pr-7 text-[12.5px] text-text-primary focus:border-accent focus:outline-none"
      >
        {!collection && <option value="">Select collection…</option>}
        {cols.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
            {typeof c.points === "number" ? ` (${c.points.toLocaleString()})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const username = getUsername();

  const logout = () => {
    clearSession();
    router.replace("/admin/login");
  };

  return (
    <div className="flex min-h-screen bg-bg-primary">
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-bg-secondary">
        <div className="border-b border-border px-5 py-4">
          <h1 className="font-heading text-[17px] font-semibold text-text-primary">Vector Console</h1>
          <p className="text-[11px] text-text-muted">المنظومة · corpus inspector</p>
        </div>

        <div className="px-4 py-4">
          <label className="mb-1.5 block text-[10.5px] font-medium uppercase tracking-wide text-text-muted">
            Collection
          </label>
          <CollectionSwitcher />
        </div>

        <nav className="flex flex-col gap-1 px-3">
          {NAV.map((item) => {
            const active = item.exact
              ? pathname === item.href
              : pathname?.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-[13px] font-medium transition ${
                  active
                    ? "bg-accent text-white"
                    : "text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
                }`}
              >
                <Icon size={15} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto border-t border-border px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-[12px] text-text-secondary">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
              {(username || "A").slice(0, 1).toUpperCase()}
            </span>
            <span className="truncate">{username || "admin"}</span>
          </div>
          <button
            onClick={logout}
            className="flex w-full items-center gap-2 rounded-[var(--radius)] border border-border px-3 py-1.5 text-[12px] text-text-secondary transition hover:border-accent/40 hover:text-accent"
          >
            <LogOut size={13} />
            Sign out
          </button>
        </div>
      </aside>

      {/* Content */}
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-8 py-7">{children}</div>
      </main>
    </div>
  );
}
