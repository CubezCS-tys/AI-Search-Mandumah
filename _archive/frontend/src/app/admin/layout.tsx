"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isAuthed } from "@/lib/admin/auth";
import { CollectionProvider } from "@/lib/admin/useCollection";
import { AdminShell } from "@/components/admin/AdminShell";

// SSR-safe "are we on the client yet" without syncing state inside an effect.
const noopSubscribe = () => () => {};
function useIsClient() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/admin/login";
  const mounted = useIsClient();

  // Redirect unauthenticated visitors (side effect only — no setState).
  useEffect(() => {
    if (mounted && !isLogin && !isAuthed()) {
      router.replace("/admin/login");
    }
  }, [mounted, isLogin, router]);

  if (isLogin) return <>{children}</>;
  if (!mounted || !isAuthed()) return <div className="min-h-screen bg-bg-primary" />;

  return (
    <CollectionProvider>
      <AdminShell>{children}</AdminShell>
    </CollectionProvider>
  );
}
