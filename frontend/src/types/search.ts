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
  // Score breakdown (PLAN B1): the engine's own sub-signals, exposed for the
  // Score Reactor. raw_score is a tiny RRF magnitude (not 0..1); normalize per
  // result set before blending. Optional: older payloads / synthesis re-ingest
  // may omit them.
  raw_score?: number;
  lexical_score?: number;
  title_score?: number;
  // MARC bibliographic fields (PLAN B2): plural lists; null until the backfill.
  authors?: string[] | null;
  year?: string | null;
  journal?: string | null;
  keywords?: string[] | null;
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

/** Document stance toward the query premise (Consensus-style meter input). */
export type EvidenceStance = "support" | "contrast" | "mixed" | "neutral";

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
  stance?: EvidenceStance;
  notes?: string;
}
