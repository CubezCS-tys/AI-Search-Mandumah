"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Loader2, ScatterChart, Play } from "lucide-react";
import {
  searchDebug,
  fetchProjection,
  type SearchDebugResponse,
  type ProjectionResponse,
} from "@/lib/admin/api";
import { useCollection } from "@/lib/admin/useCollection";
import { Card, Loading, ErrorBox, Pill } from "@/components/admin/ui";
import { ScatterPlot } from "@/components/admin/ScatterPlot";

type Tab = "retrieval" | "map";

export default function ExplorePage() {
  const { collection } = useCollection();
  const [tab, setTab] = useState<Tab>("retrieval");

  if (!collection) return <Loading label="Resolving collection…" />;

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="font-heading text-2xl font-semibold text-text-primary">Explore</h1>
        <p className="mt-0.5 text-[13px] text-text-secondary">
          Debug retrieval and visualize the vector space of <code className="font-mono">{collection}</code>
        </p>
      </header>

      <div className="flex gap-1 rounded-full border border-border bg-bg-elevated p-1 w-fit">
        <TabBtn active={tab === "retrieval"} onClick={() => setTab("retrieval")} icon={<Search size={13} />}>
          Retrieval debugger
        </TabBtn>
        <TabBtn active={tab === "map"} onClick={() => setTab("map")} icon={<ScatterChart size={13} />}>
          Vector map
        </TabBtn>
      </div>

      {tab === "retrieval" ? <RetrievalDebugger collection={collection} /> : <VectorMap collection={collection} />}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition ${
        active ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

/* ── Retrieval debugger ─────────────────────────────────────────────── */

const MODES: { key: string; label: string }[] = [
  { key: "dense", label: "Dense" },
  { key: "sparse", label: "Sparse" },
  { key: "hybrid", label: "Hybrid (RRF)" },
];

function RetrievalDebugger({ collection }: { collection: string }) {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<SearchDebugResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setData(await searchDebug(collection, query.trim(), 10));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={run} className="flex gap-2">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a query to compare dense / sparse / hybrid ranking…"
            dir="auto"
            className="w-full rounded-[var(--radius)] border border-border bg-bg-elevated py-2.5 pl-9 pr-3 text-sm text-text-primary focus:border-accent focus:outline-none font-arabic"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !query.trim()}
          className="flex items-center gap-1.5 rounded-[var(--radius)] bg-accent px-4 text-sm font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? <Loader2 className="animate-spin" size={15} /> : <Play size={14} />} Run
        </button>
      </form>

      {error && <ErrorBox message={error} />}

      {data && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {MODES.map((m) => {
            const res = data.modes[m.key];
            return (
              <Card key={m.key} className="!p-0 overflow-hidden">
                <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                  <span className="text-[13px] font-semibold text-text-primary">{m.label}</span>
                  {res?.took_ms != null && <Pill tone="muted">{res.took_ms} ms</Pill>}
                </div>
                <div className="flex flex-col">
                  {res?.error ? (
                    <p className="px-4 py-3 text-[12px] text-accent">{res.error}</p>
                  ) : (
                    res?.results.map((r) => (
                      <a
                        key={r.point_id + r.rank}
                        href={`/admin/chunks/${encodeURIComponent(r.point_id)}`}
                        className="flex gap-2.5 border-b border-border-subtle px-3 py-2.5 transition last:border-0 hover:bg-bg-secondary"
                      >
                        <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-text-muted">
                          {r.rank}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] text-accent">{r.score}</span>
                            <span className="truncate text-[11.5px] text-text-secondary font-arabic" dir="auto">
                              {r.title || r.doc_id}
                            </span>
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-[12px] text-text-primary font-arabic" dir="auto">
                            {r.text}
                          </p>
                        </div>
                      </a>
                    ))
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Vector map ─────────────────────────────────────────────────────── */

function VectorMap({ collection }: { collection: string }) {
  const router = useRouter();
  const [sample, setSample] = useState(500);
  const [colorBy, setColorBy] = useState("journal");
  const [data, setData] = useState<ProjectionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await fetchProjection(collection, sample, colorBy));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Projection failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">Sample size</span>
            <select
              value={sample}
              onChange={(e) => setSample(Number(e.target.value))}
              className="rounded-[var(--radius)] border border-border bg-bg-elevated px-3 py-1.5 text-[13px] text-text-primary focus:border-accent focus:outline-none"
            >
              {[200, 500, 1000, 1500].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">Color by</span>
            <select
              value={colorBy}
              onChange={(e) => setColorBy(e.target.value)}
              className="rounded-[var(--radius)] border border-border bg-bg-elevated px-3 py-1.5 text-[13px] text-text-primary focus:border-accent focus:outline-none"
            >
              <option value="journal">Journal</option>
              <option value="section">Section</option>
              <option value="year">Year</option>
            </select>
          </label>
          <button
            onClick={load}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-[var(--radius)] bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? <Loader2 className="animate-spin" size={15} /> : <ScatterChart size={14} />}
            {data ? "Recompute" : "Compute projection"}
          </button>
          {data && (
            <span className="text-[11.5px] text-text-muted">
              {data.count} points · PC1 {Math.round(data.explained_variance[0] * 100)}% · PC2{" "}
              {Math.round(data.explained_variance[1] * 100)}% variance
            </span>
          )}
        </div>
      </Card>

      {error && <ErrorBox message={error} />}

      {busy && !data ? (
        <Loading label="Projecting vectors (PCA)…" />
      ) : data ? (
        <Card>
          <ScatterPlot
            points={data.points}
            onSelect={(p) => router.push(`/admin/chunks/${encodeURIComponent(p.point_id)}`)}
          />
        </Card>
      ) : (
        <p className="px-1 text-[13px] text-text-muted">
          Compute a 2-D PCA projection of a sample of dense vectors. Hover a point to preview it,
          click to inspect its chunk and vectors.
        </p>
      )}
    </div>
  );
}
