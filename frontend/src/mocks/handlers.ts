import { http, HttpResponse } from "msw";
import {
  searchFixture,
  healthFixture,
  statsFixture,
  overviewFixture,
  projectionFixture,
  similarFixture,
} from "./fixtures";
import { sseStream, synthesizeFrames, corpusChatFrames, docChatFrames } from "./sse";

const sse = (frames: unknown[]) =>
  new HttpResponse(sseStream(frames), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });

// Handlers keyed to the same-origin /api/* paths the app uses (see PLAN-00b B1:
// the unified client standardizes on the rewrite). New public surfaces use the
// PLAN-CORRECTIONS-v2 contracts (insights = projection/similar only; galaxy).
export const handlers = [
  http.get("/api/health", () => HttpResponse.json(healthFixture)),
  http.get("/api/stats", () => HttpResponse.json(statsFixture)),
  http.post("/api/search", () => HttpResponse.json(searchFixture)),
  http.post("/api/search/synthesize", () => sse(synthesizeFrames())),
  http.post("/api/chat/corpus", () => sse(corpusChatFrames(true))),
  http.post("/api/chat", () => sse(docChatFrames())),
  http.get("/api/conversations", () => HttpResponse.json([])),

  // Public lab routes (PLAN-CORRECTIONS-v2 B3): projection + similar only.
  http.get("/api/insights/projection", () => HttpResponse.json(projectionFixture)),
  http.post("/api/insights/similar", () => HttpResponse.json(similarFixture)),

  // Galaxy (PLAN-01 / B4): canonical basis projection + single-embed pin.
  http.get("/api/galaxy/projection", () => HttpResponse.json(projectionFixture)),
  http.post("/api/galaxy/pin", () =>
    HttpResponse.json({
      basis_id: "basis_mock_1",
      pin: { x: 0.12, y: -0.31 },
      results: similarFixture.results,
    }),
  ),

  // Oracle (PLAN-05 / B7): one random document.
  http.get("/api/random", () => HttpResponse.json(searchFixture.results[0])),
];
