/** A single retrieved source attached to an assistant answer. */
export interface Source {
  doc_id: string;
  title: string;
  chunk_id: string;
  score: number;
  snippet: string;
  section: string;
  journal_id: string;
}

export type ChatRole = "user" | "assistant";

/** A message inside a conversation thread. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  sources?: Source[];
  created_at?: string;
}

/** Full conversation with its message history. */
export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
}

/** Lightweight conversation row for the sidebar list. */
export interface ConversationSummary {
  id: string;
  title: string;
  updated_at: string;
  preview: string;
}

/** Request body for POST /api/chat/corpus. */
export interface CorpusChatRequest {
  conversation_id?: string;
  message: string;
}

/** Streaming event handlers for the corpus chat SSE stream. */
export interface CorpusChatHandlers {
  onConversationId: (id: string) => void;
  onToken: (token: string) => void;
  onSources: (sources: Source[]) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}
