export interface SearchRequest {
  query: string;
  top_k?: number;
  mode?: "hybrid" | "dense" | "sparse";
  journal_id?: string;
  section?: string;
  doc_id?: string;
  deduplicate?: boolean;
  hyde?: boolean;
}

export type SynthesisMode = "standard" | "advanced";
export type SynthesisApiMode = "fast" | "advanced";

export interface SynthesisRequest {
  query: string;
  results: SearchResultItem[];
  mode?: SynthesisApiMode;
  max_documents?: number;
  chunks_per_document?: number;
  use_hyde?: boolean;
  search_mode?: SearchMode;
  journal_id?: string;
  section?: string;
  doc_id?: string;
}

export interface SearchResultItem {
  chunk_id: string;
  doc_id: string;
  text: string;
  title: string;
  section: string;
  score: number;
  chunk_index: number;
  journal_id: string;
  char_len: number;
}

export interface SearchResponse {
  query: string;
  mode: string;
  results: SearchResultItem[];
  total: number;
  search_ms: number;
  low_confidence?: boolean;
  warning?: string | null;
}

export interface HealthResponse {
  status: "ok" | "error";
  collection?: string;
  points_count?: number;
  detail?: string;
}

export type SearchMode = "hybrid" | "dense" | "sparse";
