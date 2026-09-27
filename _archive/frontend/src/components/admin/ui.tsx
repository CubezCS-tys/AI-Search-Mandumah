"use client";

import { Loader2 } from "lucide-react";

/* Shared visual primitives for the admin console — match the editorial tokens. */

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-[var(--radius-lg)] border border-border bg-bg-elevated p-5 shadow-[var(--shadow-sm)] ${className}`}
    >
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
        {label}
      </span>
      <span className="text-2xl font-semibold tabular-nums text-text-primary">{value}</span>
      {hint && <span className="text-[11.5px] text-text-secondary">{hint}</span>}
    </Card>
  );
}

export function SectionTitle({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-text-secondary">
        {children}
      </h2>
      {right}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-text-secondary">
      <Loader2 className="animate-spin" size={16} />
      {label}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-[var(--radius)] border border-accent/30 bg-accent-subtle px-4 py-3 text-sm text-accent">
      {message}
    </div>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "muted";
}) {
  const tones = {
    neutral: "border-border bg-bg-secondary text-text-secondary",
    accent: "border-accent/30 bg-accent-subtle text-accent",
    muted: "border-border-subtle bg-transparent text-text-muted",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-bg-secondary px-1.5 py-0.5 font-mono text-[12px] text-text-primary">
      {children}
    </code>
  );
}
