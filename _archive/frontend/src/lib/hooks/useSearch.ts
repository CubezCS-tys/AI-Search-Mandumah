"use client";

import useSWR from "swr";
import { search } from "@/lib/api";
import type { SearchRequest, SearchResponse } from "@/types/search";

/* ── Prefetch cache (module-level, survives across renders) ── */

let _prefetchedKey: string | null = null;
let _prefetchedData: SearchResponse | null = null;

export function setPrefetchedSearch(
  params: SearchRequest,
  data: SearchResponse
) {
  _prefetchedKey = JSON.stringify(params);
  _prefetchedData = data;
}

export function useSearch(params: SearchRequest | null) {
  const key = params?.query ? JSON.stringify(params) : null;

  const { data, error, isLoading, mutate } = useSWR<SearchResponse>(
    key,
    () => {
      if (key && key === _prefetchedKey && _prefetchedData) {
        const d = _prefetchedData;
        _prefetchedKey = null;
        _prefetchedData = null;
        return Promise.resolve(d);
      }
      return search(params!);
    },
    {
      revalidateOnFocus: false,
      dedupingInterval: 2000,
    }
  );

  return { data, error, isLoading, mutate };
}
