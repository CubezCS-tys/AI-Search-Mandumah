"use client";

import { useEffect, useRef, useState } from "react";
import { healthCheck } from "@/lib/api";

type Status = "checking" | "online" | "degraded" | "offline";

const META: Record<
  Exclude<Status, "checking">,
  { label: string; dot: string; text: string; title: string }
> = {
  online: {
    label: "متصل",
    dot: "bg-emerald-500",
    text: "text-emerald-600",
    title: "الخدمة تعمل بشكل طبيعي",
  },
  degraded: {
    label: "أداء منخفض",
    dot: "bg-amber-500",
    text: "text-amber-600",
    title: "الخدمة متاحة لكن قاعدة البيانات غير متصلة",
  },
  offline: {
    label: "غير متصل",
    dot: "bg-rose-500",
    text: "text-rose-600",
    title: "تعذّر الوصول إلى الخادم",
  },
};

const POLL_MS = 30_000;

/**
 * Compact readiness badge that polls /api/health and reflects the backend's
 * health: online (Qdrant reachable), degraded (API up, Qdrant error), or
 * offline (API unreachable). Renders nothing until the first check resolves.
 */
export default function HealthIndicator() {
  const [status, setStatus] = useState<Status>("checking");
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;

    const check = async () => {
      try {
        const res = await healthCheck();
        if (cancelled.current) return;
        setStatus(res.status === "ok" ? "online" : "degraded");
      } catch {
        if (cancelled.current) return;
        setStatus("offline");
      }
    };

    check();
    const id = setInterval(check, POLL_MS);
    return () => {
      cancelled.current = true;
      clearInterval(id);
    };
  }, []);

  if (status === "checking") return null;

  const meta = META[status];

  return (
    <span
      title={meta.title}
      className={`flex items-center gap-1.5 rounded-full bg-bg-elevated px-2 py-0.5 text-[11px] font-arabic font-medium ${meta.text}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${meta.dot} ${
          status === "online" ? "" : "animate-pulse"
        }`}
        aria-hidden
      />
      {meta.label}
    </span>
  );
}
