import type { SearchRequest, SearchResponse, HealthResponse, SearchResultItem } from "@/types/search";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export async function search(params: SearchRequest): Promise<SearchResponse> {
  const res = await fetch(`${API_BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Search failed: ${res.status}`);
  }

  return res.json();
}

export async function healthCheck(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE}/api/health`);
  return res.json();
}

export async function streamSynthesis(
  query: string,
  results: SearchResultItem[],
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/search/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, results }),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    onError(err.detail || `Synthesis failed: ${res.status}`);
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) { onError("No response body"); return; }
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value, { stream: true }).split("\n");
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") { onDone(); return; }
      try {
        const parsed = JSON.parse(payload);
        if (parsed.token) onToken(parsed.token);
        else if (parsed.error) { onError(parsed.error); return; }
      } catch { /* incomplete chunk */ }
    }
  }
  onDone();
}
