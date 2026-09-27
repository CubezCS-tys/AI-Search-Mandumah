"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { ArrowLeft, Copy, Check, Sparkles } from "lucide-react";
import { fetchPoint, fetchSimilar } from "@/lib/admin/api";
import { useCollection } from "@/lib/admin/useCollection";
import { Card, Loading, ErrorBox, SectionTitle, Pill } from "@/components/admin/ui";
import { DenseVector, SparseVector } from "@/components/admin/VectorViz";

export default function ChunkInspectorPage() {
  const params = useParams<{ pointId: string }>();
  const pointId = decodeURIComponent(params.pointId);
  const { collection } = useCollection();
  const [copied, setCopied] = useState(false);
  const [showSimilar, setShowSimilar] = useState(false);

  const { data, error, isLoading } = useSWR(
    collection ? ["point", collection, pointId] : null,
    () => fetchPoint(collection!, pointId),
  );
  const { data: similar, isLoading: simLoading } = useSWR(
    showSimilar && collection ? ["similar", collection, pointId] : null,
    () => fetchSimilar(collection!, pointId, 10),
  );

  if (!collection) return <Loading label="Resolving collection…" />;
  if (error) return <ErrorBox message={(error as Error).message} />;
  if (isLoading || !data) return <Loading label="Loading point…" />;

  const p = data.payload as Record<string, unknown>;
  const docId = p.doc_id as string | undefined;
  const copyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <Link
          href={docId ? `/admin/documents/${encodeURIComponent(docId)}` : "/admin/documents"}
          className="flex w-fit items-center gap-1.5 text-[13px] text-text-secondary transition hover:text-accent"
        >
          <ArrowLeft size={14} /> {docId ? "Back to document" : "Documents"}
        </Link>
        <button
          onClick={copyJson}
          className="flex items-center gap-1.5 rounded-[var(--radius)] border border-border px-2.5 py-1 text-[12px] text-text-secondary transition hover:border-accent/40 hover:text-accent"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} Copy JSON
        </button>
      </div>

      <header>
        <h1 className="font-heading text-xl font-semibold text-text-primary">Chunk inspector</h1>
        <code className="font-mono text-[11.5px] text-text-muted">{data.point_id}</code>
      </header>

      {/* Payload metadata */}
      <Card>
        <SectionTitle>Payload</SectionTitle>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-[12.5px] md:grid-cols-3">
          {Object.entries(p)
            .filter(([k]) => k !== "text")
            .map(([k, v]) => (
              <div key={k} className="flex flex-col gap-0.5">
                <span className="text-[10.5px] uppercase tracking-wide text-text-muted">{k}</span>
                <span className="break-words font-arabic text-text-primary" dir="auto">
                  {String(v)}
                </span>
              </div>
            ))}
        </div>
      </Card>

      {/* Chunk text */}
      <Card>
        <SectionTitle>Text</SectionTitle>
        <p className="whitespace-pre-wrap font-arabic text-[14px] leading-relaxed text-text-primary" dir="auto">
          {String(p.text ?? "")}
        </p>
      </Card>

      {/* Vectors */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Dense vector</SectionTitle>
          {data.dense ? <DenseVector dense={data.dense} /> : <p className="text-sm text-text-muted">No dense vector.</p>}
        </Card>
        <Card>
          <SectionTitle>Sparse vector</SectionTitle>
          {data.sparse ? <SparseVector sparse={data.sparse} /> : <p className="text-sm text-text-muted">No sparse vector.</p>}
        </Card>
      </div>

      {/* Similar chunks */}
      <Card>
        <SectionTitle
          right={
            !showSimilar ? (
              <button
                onClick={() => setShowSimilar(true)}
                className="flex items-center gap-1.5 rounded-[var(--radius)] border border-border px-2.5 py-1 text-[12px] text-text-secondary transition hover:border-accent/40 hover:text-accent"
              >
                <Sparkles size={13} /> Find similar
              </button>
            ) : undefined
          }
        >
          Nearest neighbours
        </SectionTitle>
        {!showSimilar ? (
          <p className="text-[12.5px] text-text-muted">
            Find the closest chunks by dense-vector cosine similarity.
          </p>
        ) : simLoading || !similar ? (
          <Loading label="Searching neighbours…" />
        ) : (
          <div className="flex flex-col gap-2">
            {similar.results.map((r) => (
              <Link
                key={r.point_id}
                href={`/admin/chunks/${encodeURIComponent(r.point_id)}`}
                className="flex items-start gap-3 rounded-[var(--radius)] border border-border-subtle px-3 py-2.5 transition hover:border-accent/40 hover:bg-bg-secondary"
              >
                <Pill tone="accent">{r.score.toFixed(3)}</Pill>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-arabic text-[13px] text-text-primary" dir="auto">
                    {r.title || r.doc_id}
                  </div>
                  <div className="truncate text-[12px] text-text-secondary font-arabic" dir="auto">
                    {r.text}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
