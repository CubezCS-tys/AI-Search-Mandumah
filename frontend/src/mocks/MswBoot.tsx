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
    if (!ENABLED) return;
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
