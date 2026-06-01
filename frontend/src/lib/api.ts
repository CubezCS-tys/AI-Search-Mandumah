import type {
  HealthResponse,
  SearchRequest,
  SearchResponse,
  SynthesisRequest,
} from "@/types/search";
import type {
  Conversation,
  ConversationSummary,
  CorpusChatHandlers,
  CorpusChatRequest,
  Source,
} from "@/types/chat";

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
  request: SynthesisRequest,
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/search/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
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
  let buffer = "";
  let completed = false;

  const handleLine = (line: string) => {
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") {
      completed = true;
      onDone();
      return;
    }

    try {
      const parsed = JSON.parse(payload);
      if (parsed.token) onToken(parsed.token);
      else if (parsed.error) {
        completed = true;
        onError(parsed.error);
      }
    } catch {
      onError("Malformed synthesis stream");
      completed = true;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      handleLine(line);
      if (completed) return;
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer) {
    handleLine(buffer.replace(/\r$/, ""));
  }
  if (!completed) onDone();
}

/* ── Corpus-wide conversational chat ─────────────────────────── */

/**
 * Streams a corpus-wide chat answer over SSE. Mirrors `streamSynthesis`'s
 * parser but additionally handles `conversation_id` and `sources` events.
 *
 * Event order from the server:
 *   data: {"conversation_id": "..."}   (first)
 *   data: {"token": "..."}             (many)
 *   data: {"sources": [...]}           (once)
 *   data: [DONE]
 */
export async function streamCorpusChat(
  request: CorpusChatRequest,
  handlers: CorpusChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const { onConversationId, onToken, onSources, onDone, onError } = handlers;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/chat/corpus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    onError(e instanceof Error ? e.message : "Network error");
    return;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    onError(err.detail || `Chat failed: ${res.status}`);
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) { onError("No response body"); return; }
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  const handleLine = (line: string) => {
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") {
      completed = true;
      onDone();
      return;
    }

    try {
      const parsed = JSON.parse(payload) as {
        conversation_id?: string;
        token?: string;
        sources?: Source[];
        error?: string;
      };
      if (parsed.conversation_id) onConversationId(parsed.conversation_id);
      else if (parsed.token) onToken(parsed.token);
      else if (parsed.sources) onSources(parsed.sources);
      else if (parsed.error) {
        completed = true;
        onError(parsed.error);
      }
    } catch {
      onError("Malformed chat stream");
      completed = true;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line);
        if (completed) return;
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } catch (e) {
    if (signal?.aborted) return;
    onError(e instanceof Error ? e.message : "Stream error");
    return;
  }

  buffer += decoder.decode();
  if (buffer) {
    handleLine(buffer.replace(/\r$/, ""));
  }
  if (!completed) onDone();
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const res = await fetch(`${API_BASE}/api/conversations`);
  if (!res.ok) {
    throw new Error(`Failed to load conversations: ${res.status}`);
  }
  return res.json();
}

export async function getConversation(id: string): Promise<Conversation> {
  const res = await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(id)}`);
  if (!res.ok) {
    throw new Error(`Failed to load conversation: ${res.status}`);
  }
  return res.json();
}

export async function renameConversation(
  id: string,
  title: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw new Error(`Failed to rename conversation: ${res.status}`);
  }
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`Failed to delete conversation: ${res.status}`);
  }
}
