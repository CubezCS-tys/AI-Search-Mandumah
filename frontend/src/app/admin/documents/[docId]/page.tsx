"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { ArrowLeft, ChevronDown, ChevronRight, Boxes } from "lucide-react";
import { fetchDocChunks } from "@/lib/admin/api";
import { useCollection } from "@/lib/admin/useCollection";
import { Card, Loading, ErrorBox, Pill } from "@/components/admin/ui";

export default function DocChunksPage() {
  const params = useParams<{ docId: string }>();
  const docId = decodeURIComponent(params.docId);
  const { collection } = useCollection();
  const [open, setOpen] = useState<string | null>(null);

  const { data, error, isLoading } = useSWR(
    collection ? ["doc-chunks", collection, docId] : null,
    () => fetchDocChunks(collection!, docId),
  );

  if (!collection) return <Loading label="Resolving collection…" />;

  return (
    <div className="flex flex-col gap-5">
      <Link
        href="/admin/documents"
        className="flex w-fit items-center gap-1.5 text-[13px] text-text-secondary transition hover:text-accent"
      >
        <ArrowLeft size={14} /> Documents
      </Link>

      <header>
        <h1 className="font-heading text-xl font-semibold text-text-primary font-arabic" dir="auto">
          {data?.title || docId}
        </h1>
        <p className="mt-1 flex items-center gap-2 text-[13px] text-text-secondary">
          <code className="font-mono">{docId}</code>
          {data && <Pill tone="muted">{data.count} chunks</Pill>}
        </p>
      </header>

      {error ? (
        <ErrorBox message={(error as Error).message} />
      ) : isLoading || !data ? (
        <Loading label="Loading chunks…" />
      ) : (
        <div className="flex flex-col gap-2">
          {data.chunks.map((c) => {
            const expanded = open === c.point_id;
            return (
              <Card key={c.point_id} className="!p-0 overflow-hidden">
                <button
                  onClick={() => setOpen(expanded ? null : c.point_id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-bg-secondary"
                >
                  {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  <span className="flex h-6 w-8 shrink-0 items-center justify-center rounded bg-accent/10 text-[11px] font-semibold tabular-nums text-accent">
                    {c.chunk_index ?? "?"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text-secondary font-arabic" dir="auto">
                    {c.section || "—"}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-text-muted">
                    {c.char_len ?? (c.text?.length ?? 0)} ch
                  </span>
                </button>

                {expanded && (
                  <div className="border-t border-border-subtle px-4 py-3">
                    <p
                      className="whitespace-pre-wrap font-arabic text-[14px] leading-relaxed text-text-primary"
                      dir="auto"
                    >
                      {c.text}
                    </p>
                    <div className="mt-3 flex items-center justify-between border-t border-border-subtle pt-3">
                      <code className="font-mono text-[11px] text-text-muted">{c.point_id}</code>
                      <Link
                        href={`/admin/chunks/${encodeURIComponent(c.point_id)}`}
                        className="flex items-center gap-1.5 rounded-[var(--radius)] border border-border px-2.5 py-1 text-[12px] text-text-secondary transition hover:border-accent/40 hover:text-accent"
                      >
                        <Boxes size={13} /> Inspect vectors
                      </Link>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
