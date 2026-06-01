"use client";

import { useState, useCallback, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { MessageSquare } from "lucide-react";
import Header from "@/components/layout/Header";
import SearchBar from "@/components/search/SearchBar";
import SearchFilters from "@/components/search/SearchFilters";
import SearchFacets from "@/components/search/SearchFacets";
import SearchResults from "@/components/search/SearchResults";
import SearchMeta from "@/components/search/SearchMeta";
import ResultSkeleton from "@/components/search/ResultSkeleton";
import SynthesisPanel from "@/components/search/SynthesisPanel";
import ReferenceCarousel from "@/components/search/ReferenceCarousel";
import DocumentPreview from "@/components/search/DocumentPreview";
import { useSearch } from "@/lib/hooks/useSearch";
import type { SearchMode, SearchResponse, SearchResultItem, SynthesisMode } from "@/types/search";

interface SearchResultsWorkspaceProps {
  searchKey: string;
  query: string;
  data: SearchResponse;
  searchMode: SearchMode;
  hydeEnabled: boolean;
  filters: {
    journalId: string;
    section: string;
    docId: string;
  };
  synthesisMode: SynthesisMode;
  onSynthesisModeChange: (mode: SynthesisMode) => void;
  onActiveChange: (active: boolean) => void;
}

function SearchResultsWorkspace({
  searchKey,
  query,
  data,
  searchMode,
  hydeEnabled,
  filters,
  synthesisMode,
  onSynthesisModeChange,
  onActiveChange,
}: SearchResultsWorkspaceProps) {
  const [synthesisActive, setSynthesisActive] = useState(false);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [previewResult, setPreviewResult] = useState<{ result: SearchResultItem; index: number } | null>(null);

  useEffect(() => {
    onActiveChange(synthesisActive);
  }, [onActiveChange, synthesisActive]);

  const handleSynthesisStateChange = useCallback((active: boolean) => {
    setSynthesisActive(active);
    if (!active) {
      setCarouselIndex(0);
      setPreviewResult(null);
    }
  }, []);

  const handleCitationClick = useCallback(
    (index: number) => {
      setCarouselIndex(index);
      if (data.results[index]) {
        setPreviewResult({ result: data.results[index], index });
      }
    },
    [data],
  );

  return (
    <div
      className={`grid ${
        synthesisActive
          ? "items-start gap-6 lg:grid-cols-[1fr_1fr]"
          : "grid-cols-1"
      }`}
    >
      <div>
        {data.results.length > 0 && (
          <SynthesisPanel
            key={`${searchKey}|${synthesisMode}`}
            query={query}
            results={data.results}
            synthesisMode={synthesisMode}
            searchMode={searchMode}
            hydeEnabled={hydeEnabled}
            filters={filters}
            onSynthesisModeChange={onSynthesisModeChange}
            onCitationClick={handleCitationClick}
            onSynthesisStateChange={handleSynthesisStateChange}
            activeCarouselIndex={carouselIndex}
          />
        )}
        {!synthesisActive && (
          <SearchResults results={data.results} query={query} />
        )}
      </div>

      {synthesisActive && data.results.length > 0 && (
        previewResult ? (
          <DocumentPreview
            key={previewResult.result.doc_id}
            result={previewResult.result}
            citationIndex={previewResult.index}
            query={query}
            onClose={() => setPreviewResult(null)}
          />
        ) : (
          <ReferenceCarousel
            results={data.results}
            activeIndex={carouselIndex}
            onSelect={setCarouselIndex}
            query={query}
          />
        )
      )}
    </div>
  );
}

function SearchPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const queryParam = searchParams.get("q") || "";
  const modeParam = (searchParams.get("mode") || "hybrid") as SearchMode;
  const synthesisParam = searchParams.get("synth") === "advanced" ? "advanced" : "standard";
  const hydeParam = searchParams.get("hyde") === "1";

  const [query, setQuery] = useState(queryParam);
  const [mode, setMode] = useState<SearchMode>(modeParam);
  const [hydeEnabled, setHydeEnabled] = useState(hydeParam);
  const [synthesisMode, setSynthesisMode] = useState<SynthesisMode>(synthesisParam);
  const [filters, setFilters] = useState({
    journalId: searchParams.get("journal") || "",
    section: searchParams.get("section") || "",
    docId: searchParams.get("doc") || "",
  });
  const [synthesisActive, setSynthesisActive] = useState(false);

  const searchContextKey = [
    query,
    mode,
    hydeEnabled ? "hyde" : "no-hyde",
    filters.journalId,
    filters.section,
    filters.docId,
  ].join("|");

  // Build search request
  const searchRequest = query
    ? {
        query,
        mode,
        top_k: 20,
        hyde: hydeEnabled,
        ...(filters.journalId && { journal_id: filters.journalId }),
        ...(filters.section && { section: filters.section }),
        ...(filters.docId && { doc_id: filters.docId }),
      }
    : null;

  const { data, isLoading, error } = useSearch(searchRequest);

  const handleSearch = useCallback(
    (newQuery: string, newMode: SearchMode, nextHyde: boolean) => {
      setQuery(newQuery);
      setMode(newMode);
      setHydeEnabled(nextHyde);
      setSynthesisActive(false);

      // Update URL without full reload
      const params = new URLSearchParams({ q: newQuery, mode: newMode, synth: synthesisMode });
      if (nextHyde) params.set("hyde", "1");
      if (filters.journalId) params.set("journal", filters.journalId);
      if (filters.section) params.set("section", filters.section);
      if (filters.docId) params.set("doc", filters.docId);
      router.replace(`/search?${params.toString()}`, { scroll: false });
    },
    [router, filters, synthesisMode]
  );

  const handleFilterChange = useCallback(
    (newFilters: typeof filters) => {
      setFilters(newFilters);
      setSynthesisActive(false);

      // Update URL
      const params = new URLSearchParams({ q: query, mode, synth: synthesisMode });
      if (hydeEnabled) params.set("hyde", "1");
      if (newFilters.journalId) params.set("journal", newFilters.journalId);
      if (newFilters.section) params.set("section", newFilters.section);
      if (newFilters.docId) params.set("doc", newFilters.docId);
      router.replace(`/search?${params.toString()}`, { scroll: false });
    },
    [router, query, mode, synthesisMode, hydeEnabled]
  );

  const handleSynthesisModeChange = useCallback(
    (nextMode: SynthesisMode) => {
      setSynthesisMode(nextMode);
      setSynthesisActive(false);

      const params = new URLSearchParams({ q: query, mode, synth: nextMode });
      if (hydeEnabled) params.set("hyde", "1");
      if (filters.journalId) params.set("journal", filters.journalId);
      if (filters.section) params.set("section", filters.section);
      if (filters.docId) params.set("doc", filters.docId);
      router.replace(`/search?${params.toString()}`, { scroll: false });
    },
    [router, query, mode, filters, hydeEnabled],
  );

  return (
    <div className="min-h-svh bg-bg-primary">
      <Header compact />

      {/* Sticky search bar */}
      <div className="sticky top-[53px] z-30 border-b border-border-subtle bg-bg-primary/80 backdrop-blur-xl">
        <div className="mx-auto max-w-3xl px-5 py-2.5">
          <SearchBar
            key={`${queryParam}|${modeParam}|${hydeParam ? "hyde" : "plain"}`}
            initialQuery={queryParam}
            initialMode={modeParam}
            initialHyde={hydeParam}
            variant="compact"
            onSearch={handleSearch}
          />
        </div>
      </div>

      {/* Results */}
      <main className={`mx-auto px-5 py-5 ${synthesisActive ? "max-w-[1280px]" : "max-w-3xl"}`}>
        {/* Filters + meta row */}
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <SearchFilters
              journalId={filters.journalId}
              section={filters.section}
              docId={filters.docId}
              onChange={handleFilterChange}
            />
            {data && !isLoading && (
              <SearchMeta
                total={data.total}
                searchMs={data.search_ms}
                mode={data.mode}
              />
            )}
          </div>
          {query && data && !isLoading && (
            <button
              onClick={() =>
                router.push(`/chat?q=${encodeURIComponent(query)}`)
              }
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-bg-elevated px-3 py-1.5 font-arabic text-[12px] font-medium text-text-muted transition hover:border-accent/40 hover:text-accent"
            >
              <MessageSquare size={13} />
              اسأل في المحادثة
            </button>
          )}
        </div>

        {/* Error state */}
        {error && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-center">
            <p className="font-arabic text-sm text-rose-700">
              حدث خطأ أثناء البحث. يرجى المحاولة مرة أخرى.
            </p>
            <p className="mt-1 text-xs text-rose-500" dir="ltr">
              {error.message}
            </p>
          </div>
        )}

        {/* Loading */}
        {isLoading && <ResultSkeleton count={5} />}

        {/* Synthesis + results — two-column grid when synthesis is active */}
        {data && !isLoading && (
          <>
            {data.warning && hydeEnabled && (
              <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 font-arabic text-sm leading-relaxed text-amber-800">
                {data.warning}
              </div>
            )}
            {!synthesisActive && data.results.length > 0 && (
              <SearchFacets
                results={data.results}
                filters={filters}
                onChange={handleFilterChange}
              />
            )}
            <SearchResultsWorkspace
              key={searchContextKey}
              searchKey={searchContextKey}
              query={query}
              data={data}
              searchMode={mode}
              hydeEnabled={hydeEnabled}
              filters={filters}
              synthesisMode={synthesisMode}
              onSynthesisModeChange={handleSynthesisModeChange}
              onActiveChange={setSynthesisActive}
            />
          </>
        )}

        {/* No query state */}
        {!query && !isLoading && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="font-arabic text-sm text-text-muted">
              أدخل استعلام البحث للبدء
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense>
      <SearchPageContent />
    </Suspense>
  );
}
