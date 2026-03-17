"use client";

import useSWR from "swr";
import { search } from "@/lib/api";
import type { SearchRequest, SearchResponse } from "@/types/search";

export function useSearch(params: SearchRequest | null) {
  const key = params?.query ? JSON.stringify(params) : null;

  const { data, error, isLoading, mutate } = useSWR<SearchResponse>(
    key,
    () => search(params!),
    {
      revalidateOnFocus: false,
      dedupingInterval: 2000,
    }
  );

  return { data, error, isLoading, mutate };
}
