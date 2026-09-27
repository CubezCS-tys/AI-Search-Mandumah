"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import { fetchDocuments } from "@/lib/admin/api";
import { useCollection } from "@/lib/admin/useCollection";
import { Card, Loading, ErrorBox, Pill } from "@/components/admin/ui";

const PAGE = 25;

export default function DocumentsPage() {
  const { collection } = useCollection();
  const [offset, setOffset] = useState(0);
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");

  const { data, error, isLoading } = useSWR(
    collection ? ["documents", collection, offset, q] : null,
    () => fetchDocuments(collection!, offset, PAGE, q || undefined),
    { keepPreviousData: true },
  );

  if (!collection) return <Loading label="Resolving collection…" />;

  const total = data?.total ?? 0;
  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="font-heading text-2xl font-semibold text-text-primary">Documents</h1>
        <p className="mt-0.5 text-[13px] text-text-secondary">
          {total.toLocaleString()} unique documents in <code className="font-mono">{collection}</code>
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setQ(qInput.trim());
        }}
        className="relative max-w-md"
      >
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Filter by document ID…"
          className="w-full rounded-[var(--radius)] border border-border bg-bg-elevated py-2 pl-9 pr-3 text-sm text-text-primary focus:border-accent focus:outline-none"
        />
      </form>

      {error ? (
        <ErrorBox message={(error as Error).message} />
      ) : isLoading && !data ? (
        <Loading label="Loading documents…" />
      ) : (
        <Card className="!p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-text-muted">
                <th className="px-4 py-2.5 font-medium">Document ID</th>
                <th className="px-4 py-2.5 font-medium">Title</th>
                <th className="px-4 py-2.5 font-medium">Journal</th>
                <th className="px-4 py-2.5 text-right font-medium">Chunks</th>
              </tr>
            </thead>
            <tbody>
              {data?.documents.map((d) => (
                <tr
                  key={d.doc_id}
                  className="border-b border-border-subtle transition last:border-0 hover:bg-bg-secondary"
                >
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/admin/documents/${encodeURIComponent(d.doc_id)}`}
                      className="font-mono text-[12.5px] text-accent hover:underline"
                    >
                      {d.doc_id}
                    </Link>
                  </td>
                  <td className="max-w-xs truncate px-4 py-2.5 font-arabic text-text-primary" dir="auto">
                    {d.title || <span className="text-text-muted">—</span>}
                  </td>
                  <td className="px-4 py-2.5 font-arabic text-text-secondary" dir="auto">
                    {d.journal || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Pill tone="muted">{d.chunks}</Pill>
                  </td>
                </tr>
              ))}
              {data && !data.documents.length && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-text-muted">
                    No documents match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      <div className="flex items-center justify-between text-[13px] text-text-secondary">
        <span>
          Page {page} of {pages}
        </span>
        <div className="flex gap-2">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
            className="flex items-center gap-1 rounded-[var(--radius)] border border-border px-3 py-1.5 transition hover:border-accent/40 disabled:opacity-40"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <button
            disabled={offset + PAGE >= total}
            onClick={() => setOffset(offset + PAGE)}
            className="flex items-center gap-1 rounded-[var(--radius)] border border-border px-3 py-1.5 transition hover:border-accent/40 disabled:opacity-40"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
