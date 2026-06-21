import { describe, it, expect } from "vitest";
import { searchFixture, projectionFixture, overviewFixture, similarFixture } from "./fixtures";
import { sseStream, synthesizeFrames, corpusChatFrames, synthesisEvidence } from "./sse";

// The mock DATA layer (fixtures + SSE builders) is unit-tested directly here.
// MSW's network interception is same-origin and is exercised end-to-end by the
// Playwright visual tests (browser, where relative /api/* resolves correctly).

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

describe("search fixture (post-batch shape)", () => {
  it("exposes the score breakdown on every hit", () => {
    for (const hit of searchFixture.results) {
      expect(typeof hit.raw_score).toBe("number");
      expect(typeof hit.lexical_score).toBe("number");
      expect(typeof hit.title_score).toBe("number");
    }
  });
  it("uses plural-list MARC fields, with at least one null (MARC-absent) doc", () => {
    const allHavePluralKeys = searchFixture.results.every(
      (h) => "authors" in h && "keywords" in h && "journal" in h && "year" in h,
    );
    expect(allHavePluralKeys).toBe(true);
    expect(searchFixture.results.some((h) => h.authors === null)).toBe(true);
  });
});

describe("sseStream", () => {
  it("frames each event as data: <json> and emits the [DONE] sentinel", async () => {
    const text = await readStream(sseStream([{ token: "a" }, "[DONE]"]));
    expect(text).toBe('data: {"token":"a"}\n\ndata: [DONE]\n\n');
  });
});

describe("synthesize stream", () => {
  it("streams tokens then the evidence array then [DONE]", async () => {
    const text = await readStream(sseStream(synthesizeFrames()));
    expect(text).toContain('"token"');
    expect(text).toContain('"evidence"');
    expect(text.trim().endsWith("[DONE]")).toBe(true);
  });
  it("carries varied stances for the Evidence Console (support/mixed/contrast)", () => {
    const stances = synthesisEvidence.map((e) => e.stance);
    expect(new Set(stances).size).toBeGreaterThanOrEqual(3);
  });
});

describe("corpus chat stream", () => {
  it("emits meta + sources BEFORE tokens (reveal-not-live order)", async () => {
    const text = await readStream(sseStream(corpusChatFrames(true)));
    const metaAt = text.indexOf('"meta"');
    const sourcesAt = text.indexOf('"sources"');
    const tokenAt = text.indexOf('"token"');
    expect(metaAt).toBeGreaterThan(-1);
    expect(sourcesAt).toBeGreaterThan(metaAt);
    expect(tokenAt).toBeGreaterThan(sourcesAt);
  });
  it("carries plural sub_queries in deep mode", async () => {
    const text = await readStream(sseStream(corpusChatFrames(true)));
    expect(text).toContain('"sub_queries"');
  });
});

describe("insights fixtures", () => {
  it("projection has 2 explained-variance axes and points", () => {
    expect(projectionFixture.explained_variance).toHaveLength(2);
    expect(projectionFixture.points.length).toBeGreaterThan(0);
  });
  it("overview + similar are well-formed", () => {
    expect(overviewFixture.documents).toBeGreaterThan(0);
    expect(similarFixture.results.length).toBeGreaterThan(0);
  });
});
