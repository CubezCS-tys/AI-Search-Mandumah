// Shared types for the public insight + galaxy surfaces (PLAN-CORRECTIONS-v2 B3,
// PLAN-01 B4). Lifted from the admin shapes so admin + public share one type.

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
  /** Per-axis explained variance, length 2 for the 2-D map. */
  explained_variance: number[];
  points: ProjectionPoint[];
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

export interface SimilarResponse {
  results: SimilarResult[];
}

export type ProjectionColorBy = "journal" | "section" | "year";

/** Galaxy query pin: the query is embedded once and projected into the cached
 *  canonical basis (basis_id), with the dense-nearest neighbours lit. */
export interface GalaxyPinResponse {
  basis_id: string;
  pin: { x: number; y: number };
  results: SimilarResult[];
}
