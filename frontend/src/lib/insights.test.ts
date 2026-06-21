import { describe, it, expect, vi, afterEach } from "vitest";
import { getProjection, getSimilar, pinQuery } from "./insights";
import { projectionFixture, similarFixture } from "@/mocks/fixtures";

afterEach(() => vi.restoreAllMocks());

type Call = { url: string; init?: RequestInit };

function stubFetch(json: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

describe("insights client", () => {
  it("getProjection builds the query string and never sends a collection param", async () => {
    const calls = stubFetch(projectionFixture);
    const res = await getProjection({ sample: 300, colorBy: "section" });
    expect(res.explained_variance).toHaveLength(2);
    expect(calls[0].url).toContain("/api/insights/projection?");
    expect(calls[0].url).toContain("sample=300");
    expect(calls[0].url).toContain("color_by=section");
    expect(calls[0].url).not.toContain("collection");
  });

  it("getSimilar posts point_id + top_k to the public similar route", async () => {
    const calls = stubFetch(similarFixture);
    const res = await getSimilar("pt_1", 5);
    expect(res.results.length).toBeGreaterThan(0);
    expect(calls[0].url).toBe("/api/insights/similar");
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ point_id: "pt_1", top_k: 5 });
  });

  it("pinQuery posts the query to the galaxy pin endpoint", async () => {
    const calls = stubFetch({ basis_id: "b1", pin: { x: 0, y: 0 }, results: similarFixture.results });
    const res = await pinQuery("الذكاء الاصطناعي في التعليم");
    expect(res.basis_id).toBe("b1");
    expect(calls[0].url).toBe("/api/galaxy/pin");
    expect(JSON.parse(calls[0].init!.body as string).query).toBe("الذكاء الاصطناعي في التعليم");
  });
});
