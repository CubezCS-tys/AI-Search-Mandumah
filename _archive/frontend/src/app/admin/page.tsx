"use client";

import useSWR from "swr";
import { fetchCollectionInfo, fetchOverview } from "@/lib/admin/api";
import { useCollection } from "@/lib/admin/useCollection";
import { Card, StatCard, SectionTitle, Loading, ErrorBox, Pill, Mono } from "@/components/admin/ui";
import { BarList, Histogram } from "@/components/admin/Charts";

export default function OverviewPage() {
  const { collection } = useCollection();
  const { data: ov, error: ovErr, isLoading } = useSWR(
    collection ? ["overview", collection] : null,
    () => fetchOverview(collection!),
  );
  const { data: info } = useSWR(
    collection ? ["collection-info", collection] : null,
    () => fetchCollectionInfo(collection!),
  );

  if (!collection) return <Loading label="Resolving collection…" />;
  if (ovErr) return <ErrorBox message={(ovErr as Error).message} />;
  if (isLoading || !ov) return <Loading label="Loading corpus stats…" />;

  return (
    <div className="flex flex-col gap-7">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-text-primary">Overview</h1>
          <p className="mt-0.5 text-[13px] text-text-secondary">
            Collection <Mono>{collection}</Mono>
          </p>
        </div>
        {info && (
          <Pill tone={info.status === "green" ? "accent" : "neutral"}>● {info.status}</Pill>
        )}
      </header>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Documents" value={ov.documents.toLocaleString()} />
        <StatCard label="Chunks" value={ov.chunks.toLocaleString()} />
        <StatCard label="Avg chunks / doc" value={ov.avg_chunks_per_doc} />
        <StatCard
          label="Avg chunk length"
          value={`${ov.avg_char_len}`}
          hint="characters"
        />
      </div>

      {/* Vector config */}
      {info && (
        <Card>
          <SectionTitle>Vector configuration</SectionTitle>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-[13px] md:grid-cols-4">
            <Field label="Dense dim" value={info.dense?.size ?? "—"} />
            <Field label="Distance" value={info.dense?.distance ?? "—"} />
            <Field
              label="Quantization"
              value={(info.quantization?.type as string) ?? "none"}
            />
            <Field
              label="HNSW m / ef"
              value={info.hnsw ? `${info.hnsw.m} / ${info.hnsw.ef_construct}` : "—"}
            />
            <Field
              label="Sparse"
              value={info.sparse ? `${info.sparse.names.join(", ")} · ${info.sparse.modifier ?? ""}` : "—"}
            />
            <Field label="Segments" value={info.segments_count ?? "—"} />
            <Field
              label="Indexed vectors"
              value={info.indexed_vectors_count?.toLocaleString() ?? "—"}
            />
            <Field
              label="On disk"
              value={info.dense?.on_disk ? "yes" : "no"}
            />
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Chunk length distribution</SectionTitle>
          <Histogram data={ov.char_len_histogram} />
          <p className="mt-2 text-[11px] text-text-muted">
            sample of {ov.histogram_sample.toLocaleString()} chunks
          </p>
        </Card>

        <Card>
          <SectionTitle>Top journals</SectionTitle>
          <BarList data={ov.top_journals} emptyLabel="No journal facet (field not indexed)" />
        </Card>
      </div>

      <Card>
        <SectionTitle>Sections</SectionTitle>
        <BarList data={ov.top_sections} emptyLabel="No section facet available" />
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-text-muted">{label}</span>
      <span className="font-medium text-text-primary">{value}</span>
    </div>
  );
}
