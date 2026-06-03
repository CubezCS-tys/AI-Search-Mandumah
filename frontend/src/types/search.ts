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
  suggestions?: string[];
}

export interface HealthResponse {
  status: "ok" | "error";
  collection?: string;
  points_count?: number;
  detail?: string;
}

export type SearchMode = "hybrid" | "dense" | "sparse";

/** A single extracted finding/claim with its supporting evidence. */
export interface EvidenceFinding {
  claim: string;
  evidence?: string;
  chunk_refs?: number[];
}

/** A single extracted statistic with its surrounding context. */
export interface EvidenceStatistic {
  value: string;
  context?: string;
  chunk_refs?: number[];
}

/** Structured evidence extracted from one source document (advanced mode). */
export interface EvidenceDoc {
  doc_index: number;
  doc_id: string;
  title?: string;
  research_focus?: string;
  methodology?: string;
  sample?: string;
  key_findings?: EvidenceFinding[];
  statistics?: EvidenceStatistic[];
  limitations?: string[];
  implications?: string[];
  evidence_quality?: string;
  notes?: string;
}
