// Typed client for the public insight + galaxy endpoints (PLAN-CORRECTIONS-v2
// B3, PLAN-01 B4). The collection is pinned server-side, so no collection param
// is ever sent from the browser.
import { apiGet, apiPost } from "./client";
import type {
  ProjectionResponse,
  SimilarResponse,
  ProjectionColorBy,
  GalaxyPinResponse,
} from "@/types/insights";

function projectionPath(base: string, opts?: { sample?: number; colorBy?: ProjectionColorBy }): string {
  const p = new URLSearchParams();
  if (opts?.sample) p.set("sample", String(opts.sample));
  if (opts?.colorBy) p.set("color_by", opts.colorBy);
  const qs = p.toString();
  return qs ? base + "?" + qs : base;
}

/** Public 2-D PCA scatter of the corpus (insights surface). */
export function getProjection(opts?: { sample?: number; colorBy?: ProjectionColorBy }): Promise<ProjectionResponse> {
  return apiGet<ProjectionResponse>(projectionPath("/api/insights/projection", opts));
}

/** Nearest-neighbour chunks for a point ("more like this"). */
export function getSimilar(pointId: string, topK = 8): Promise<SimilarResponse> {
  return apiPost<SimilarResponse>("/api/insights/similar", { point_id: pointId, top_k: topK });
}

/** Galaxy map served from the cached canonical basis (stable basis_id). */
export function getGalaxyProjection(opts?: { sample?: number; colorBy?: ProjectionColorBy }): Promise<ProjectionResponse> {
  return apiGet<ProjectionResponse>(projectionPath("/api/galaxy/projection", opts));
}

/** Drop a query pin: embed once, project into the cached basis, light neighbours. */
export function pinQuery(query: string): Promise<GalaxyPinResponse> {
  return apiPost<GalaxyPinResponse>("/api/galaxy/pin", { query });
}
