/** A single retrieved source attached to an assistant answer. */
export interface Source {
  doc_id: string;
  title: string;
  chunk_id: string;
  score: number;
  snippet: string;
  section: string;
  journal_id: string;
  /** Full retrieved chunk text — used to map a clicked «quote» to its source. */
  text?: string;
}

export type ChatRole = "user" | "assistant";

/** Retrieval transparency metadata emitted before the answer streams. */
export interface RetrievalMeta {
  /** Standalone query the latest turn was reformulated into ("" if unchanged). */
  rewritten_query?: string;
  /** Sub-queries used in deep/agentic retrieval (empty in normal mode). */
  sub_queries?: string[];
  /** Number of chunks retrieved for this turn. */
  source_count?: number;
  /** Whether deep (multi-step) retrieval was used. */
  deep?: boolean;
}

/** A message inside a conversation thread. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  sources?: Source[];
  /** Retrieval transparency for assistant turns. */
  meta?: RetrievalMeta | null;
  /** Proactive follow-up question suggestions for assistant turns. */
  followups?: string[];
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
  /** Re-answer the last user turn in place instead of appending a new exchange. */
  regenerate?: boolean;
  /** Retrieve more chunks for a broader answer ("more sources"). */
  retrieve_top_k?: number;
  /** Decompose the question into sub-queries and retrieve for each (deep mode). */
  deep?: boolean;
}

/** Streaming event handlers for the corpus chat SSE stream. */
export interface CorpusChatHandlers {
  onConversationId: (id: string) => void;
  onToken: (token: string) => void;
  onSources: (sources: Source[]) => void;
  onMeta: (meta: RetrievalMeta) => void;
  onFollowups: (followups: string[]) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}
