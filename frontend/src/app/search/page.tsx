"use client";

import { useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Header from "@/components/layout/Header";
import SearchBar from "@/components/search/SearchBar";
import SearchFilters from "@/components/search/SearchFilters";
import SearchResults from "@/components/search/SearchResults";
import SearchMeta from "@/components/search/SearchMeta";
import ResultSkeleton from "@/components/search/ResultSkeleton";
import { useSearch } from "@/lib/hooks/useSearch";
import type { SearchMode } from "@/types/search";

function SearchPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const queryParam = searchParams.get("q") || "";
  const modeParam = (searchParams.get("mode") || "hybrid") as SearchMode;

  const [query, setQuery] = useState(queryParam);
  const [mode, setMode] = useState<SearchMode>(modeParam);
  const [filters, setFilters] = useState({
    journalId: searchParams.get("journal") || "",
    section: searchParams.get("section") || "",
    docId: searchParams.get("doc") || "",
  });

  // Build search request
  const searchRequest = query
    ? {
        query,
        mode,
        top_k: 20,
        ...(filters.journalId && { journal_id: filters.journalId }),
        ...(filters.section && { section: filters.section }),
        ...(filters.docId && { doc_id: filters.docId }),
      }
    : null;

  const { data, isLoading, error } = useSearch(searchRequest);

  const handleSearch = useCallback(
    (newQuery: string, newMode: SearchMode) => {
      setQuery(newQuery);
      setMode(newMode);

      // Update URL without full reload
      const params = new URLSearchParams({ q: newQuery, mode: newMode });
      if (filters.journalId) params.set("journal", filters.journalId);
      if (filters.section) params.set("section", filters.section);
      if (filters.docId) params.set("doc", filters.docId);
      router.replace(`/search?${params.toString()}`, { scroll: false });
    },
    [router, filters]
  );

  const handleFilterChange = useCallback(
    (newFilters: typeof filters) => {
      setFilters(newFilters);

      // Update URL
      const params = new URLSearchParams({ q: query, mode });
      if (newFilters.journalId) params.set("journal", newFilters.journalId);
      if (newFilters.section) params.set("section", newFilters.section);
      if (newFilters.docId) params.set("doc", newFilters.docId);
      router.replace(`/search?${params.toString()}`, { scroll: false });
    },
    [router, query, mode]
  );

  return (
    <div className="min-h-svh bg-bg-primary">
      <Header compact />

      {/* Sticky search bar */}
      <div className="sticky top-[53px] z-30 border-b border-border-subtle bg-bg-primary/80 backdrop-blur-xl">
        <div className="mx-auto max-w-3xl px-5 py-2.5">
          <SearchBar
            initialQuery={queryParam}
            initialMode={modeParam}
            variant="compact"
            onSearch={handleSearch}
          />
        </div>
      </div>

      {/* Results */}
      <main className="mx-auto max-w-3xl px-5 py-5">
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

        {/* Results */}
        {data && !isLoading && (
          <SearchResults results={data.results} query={query} />
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
