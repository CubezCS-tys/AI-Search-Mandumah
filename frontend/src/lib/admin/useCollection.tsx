"use client";

import { createContext, useContext, useState } from "react";
import useSWR from "swr";
import { fetchCollections } from "./api";

const STORE_KEY = "manthooma_admin_collection";

interface Ctx {
  collection: string | null;
  setCollection: (c: string) => void;
}

const CollectionContext = createContext<Ctx>({ collection: null, setCollection: () => {} });

export function CollectionProvider({ children }: { children: React.ReactNode }) {
  const { data } = useSWR("admin/collections", fetchCollections, {
    revalidateOnFocus: false,
  });

  // Seed from localStorage lazily (client only); fall back to the server
  // default at read time so no state-syncing effect is needed.
  const [stored, setStored] = useState<string | null>(() =>
    typeof window === "undefined" ? null : window.localStorage.getItem(STORE_KEY),
  );

  const collection = stored ?? data?.default ?? null;

  const setCollection = (c: string) => {
    setStored(c);
    if (typeof window !== "undefined") window.localStorage.setItem(STORE_KEY, c);
  };

  return (
    <CollectionContext.Provider value={{ collection, setCollection }}>
      {children}
    </CollectionContext.Provider>
  );
}

export function useCollection() {
  return useContext(CollectionContext);
}
