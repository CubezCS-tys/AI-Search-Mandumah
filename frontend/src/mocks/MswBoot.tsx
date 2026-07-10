"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

// Dev-only mock boot. When NEXT_PUBLIC_API_MOCKING==="enabled" the browser
// service worker starts before children render and answers /api/* from fixtures.
// When disabled (prod / VPS phase) it is a transparent passthrough and the worker
// code is never imported.
const ENABLED = process.env.NEXT_PUBLIC_API_MOCKING === "enabled";

export function MswBoot({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(!ENABLED);

  useEffect(() => {
    if (!ENABLED) {
      // Mocking is off, but a worker installed during an earlier
      // mocking-enabled session persists per-origin and keeps intercepting
      // /api/*. Left registered it buffers SSE (synthesis/chat) instead of
      // streaming, so tear down any stale registration on load.
      if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
        // If a stale mock worker is actively controlling this page it will
        // keep buffering SSE until the page reloads without it, so reload once
        // after unregistering (the removed registration prevents a loop).
        const controlledByMock =
          navigator.serviceWorker.controller?.scriptURL.includes(
            "mockServiceWorker",
          ) ?? false;
        navigator.serviceWorker
          .getRegistrations()
          .then(async (regs) => {
            const stale = regs.filter((r) =>
              r.active?.scriptURL.includes("mockServiceWorker"),
            );
            await Promise.all(stale.map((r) => r.unregister()));
            if (controlledByMock && stale.length > 0) {
              window.location.reload();
            }
          })
          .catch(() => {});
      }
      return;
    }
    let active = true;
    import("./browser")
      .then(({ worker }) => worker.start({ onUnhandledRequest: "bypass" }))
      .then(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!ready) return null;
  return <>{children}</>;
}
