"use client";

import { clearSession, getToken } from "./auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const ADMIN = `${API_BASE}/api/admin`;

/* ── Types ──────────────────────────────────────────────────────────── */

export interface CollectionSummary {
  name: string;
  points?: number;
  status?: string;
  error?: string;
}

export interface CollectionsResponse {
  collections: CollectionSummary[];
  default: string;
  qdrant_url: string;
}

export interface CollectionInfo {
  name: string;
  status: string;
  points_count: number | null;
  segments_count: number | null;
  indexed_vectors_count: number | null;
  dense: { size: number | null; distance: string; on_disk: boolean | null } | null;
  sparse: { names: string[]; modifier: string | null } | null;
  quantization: Record<string, unknown> | null;
  hnsw: { m: number | null; ef_construct: number | null; on_disk: boolean | null } | null;
  optimizer_status: string;
}

export interface Overview {
  collection: string;
  documents: number;
  chunks: number;
  avg_chunks_per_doc: number;
  avg_char_len: number;
  char_len_histogram: { label: string; count: number }[];
  histogram_sample: number;
  top_journals: { value: string; count: number }[];
  top_sections: { value: string; count: number }[];
}

export interface DocSummary {
  doc_id: string;
  chunks: number;
  title?: string | null;
  journal?: string | null;
  year?: string | null;
  authors?: string | null;
}

export interface DocumentsResponse {
  documents: DocSummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface ChunkPayload {
  point_id: string;
  chunk_id?: string;
  doc_id?: string;
  text?: string;
  title?: string;
  section?: string;
  char_len?: number;
  chunk_index?: number;
  [k: string]: unknown;
}

export interface DocChunksResponse {
  doc_id: string;
  title?: string | null;
  count: number;
  chunks: ChunkPayload[];
}

export interface PointDetail {
  point_id: string;
  payload: Record<string, unknown>;
  dense: { dim: number; norm: number; min: number; max: number; preview: number[] } | null;
  sparse: { nnz: number; top_terms: { index: number; value: number }[] } | null;
}

export interface SimilarResult {
  point_id: string;
  score: number;
  doc_id?: string;
  title?: string;
  section?: string;
  chunk_index?: number;
  text?: string;
}

export interface DebugHit {
  rank: number;
  chunk_id: string;
  point_id: string;
  doc_id: string;
  title: string;
  section: string;
  chunk_index: number;
  score: number;
  text: string;
}

export interface SearchDebugResponse {
  query: string;
  modes: Record<string, { took_ms?: number; error?: string; results: DebugHit[] }>;
}

export interface ProjectionPoint {
  x: number;
  y: number;
  point_id: string;
  doc_id?: string;
  title?: string;
  section?: string;
  chunk_index?: number;
  color_key: string;
}

export interface ProjectionResponse {
  collection: string;
  color_by: string;
  count: number;
  explained_variance: number[];
  points: ProjectionPoint[];
}

/* ── Core fetch ─────────────────────────────────────────────────────── */

export class AuthError extends Error {}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${ADMIN}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401) {
    clearSession();
    throw new AuthError("Session expired — please sign in again.");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

/* ── Endpoints ──────────────────────────────────────────────────────── */

export async function login(username: string, password: string) {
  const res = await fetch(`${ADMIN}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Login failed");
  }
  return res.json() as Promise<{ token: string; username: string; expires_in: number }>;
}

export const fetchCollections = () => req<CollectionsResponse>("/collections");
export const fetchCollectionInfo = (name: string) =>
  req<CollectionInfo>(`/collection?name=${encodeURIComponent(name)}`);
export const fetchOverview = (collection: string) =>
  req<Overview>(`/overview?collection=${encodeURIComponent(collection)}`);

export const fetchDocuments = (
  collection: string,
  offset: number,
  limit: number,
  q?: string,
) =>
  req<DocumentsResponse>(
    `/documents?collection=${encodeURIComponent(collection)}&offset=${offset}&limit=${limit}` +
      (q ? `&q=${encodeURIComponent(q)}` : ""),
  );

export const fetchDocChunks = (collection: string, docId: string) =>
  req<DocChunksResponse>(
    `/documents/${encodeURIComponent(docId)}/chunks?collection=${encodeURIComponent(collection)}`,
  );

export const fetchPoint = (collection: string, pointId: string) =>
  req<PointDetail>(
    `/points/${encodeURIComponent(pointId)}?collection=${encodeURIComponent(collection)}`,
  );

export const fetchSimilar = (collection: string, pointId: string, topK = 10) =>
  req<{ results: SimilarResult[] }>("/similar", {
    method: "POST",
    body: JSON.stringify({ collection, point_id: pointId, top_k: topK }),
  });

export const searchDebug = (
  collection: string,
  query: string,
  topK = 10,
  docId?: string,
) =>
  req<SearchDebugResponse>("/search-debug", {
    method: "POST",
    body: JSON.stringify({ collection, query, top_k: topK, doc_id: docId || null }),
  });

export const fetchProjection = (collection: string, sample = 500, colorBy = "journal") =>
  req<ProjectionResponse>(
    `/projection?collection=${encodeURIComponent(collection)}&sample=${sample}&color_by=${encodeURIComponent(colorBy)}`,
  );
