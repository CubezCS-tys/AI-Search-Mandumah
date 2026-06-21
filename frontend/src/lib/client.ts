// Unified typed API client (PLAN-00b B1). All callers use same-origin "/api/*"
// paths; the next.config rewrite forwards them to BACKEND_URL, keeping the
// backend host and any API key server-side. Migration of the existing api.ts /
// god-component fetches onto this client happens with their characterization
// tests; new features use it directly.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function parseError(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : null;
  return typeof detail === "string" ? detail : "Request failed: " + res.status;
}

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new ApiError(res.status, await parseError(res));
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
  if (!res.ok) throw new ApiError(res.status, await parseError(res));
  return (await res.json()) as T;
}

export type SseEvent = Record<string, unknown>;

// Parse an SSE byte stream into JSON events. Exported for unit testing against
// the mock fixtures; the network entry point is streamSSE below.
export async function consumeSSE(
  stream: ReadableStream<Uint8Array>,
  onEvent: (e: SseEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === "[DONE]") return;
      try {
        onEvent(JSON.parse(payload) as SseEvent);
      } catch {
        // ignore keepalives / non-JSON lines
      }
    }
  }
}

/** Stream a POST SSE endpoint, invoking onEvent per decoded JSON frame.
 *  Resolves on the [DONE] sentinel or when the stream closes. */
export async function streamSSE(
  path: string,
  body: unknown,
  opts: { onEvent: (e: SseEvent) => void; signal?: AbortSignal; headers?: HeadersInit },
): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new ApiError(res.status, await parseError(res));
  await consumeSSE(res.body, opts.onEvent);
}
