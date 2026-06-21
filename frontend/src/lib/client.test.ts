import { describe, it, expect } from "vitest";
import { consumeSSE, type SseEvent } from "./client";
import { sseStream, corpusChatFrames } from "@/mocks/sse";

const collect = async (frames: unknown[]): Promise<SseEvent[]> => {
  const events: SseEvent[] = [];
  await consumeSSE(sseStream(frames), (e) => events.push(e));
  return events;
};

describe("consumeSSE", () => {
  it("decodes each data: frame as JSON in order", async () => {
    const events = await collect([{ token: "a" }, { token: "b" }, "[DONE]"]);
    expect(events).toEqual([{ token: "a" }, { token: "b" }]);
  });

  it("stops at the [DONE] sentinel and ignores anything after it", async () => {
    const events = await collect([{ token: "a" }, "[DONE]", { token: "b" }]);
    expect(events).toEqual([{ token: "a" }]);
  });

  it("ignores non-JSON keepalive lines", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("data: \n\ndata: not json\n\ndata: {\"token\":\"x\"}\n\ndata: [DONE]\n\n"));
        c.close();
      },
    });
    const events: SseEvent[] = [];
    await consumeSSE(stream, (e) => events.push(e));
    expect(events).toEqual([{ token: "x" }]);
  });

  it("parses the corpus-chat fixture in the real reveal order", async () => {
    const events = await collect(corpusChatFrames(true));
    expect(events[0]).toHaveProperty("conversation_id");
    const keys = events.map((e) => Object.keys(e)[0]);
    expect(keys.indexOf("meta")).toBeLessThan(keys.indexOf("sources"));
    expect(keys.indexOf("sources")).toBeLessThan(keys.indexOf("token"));
    expect(events.some((e) => "followups" in e)).toBe(true);
  });
});
