"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useLayoutEffect,
} from "react";
import { useSearchParams } from "next/navigation";
import { PanelLeft, AlertCircle } from "lucide-react";
import {
  streamCorpusChat,
  listConversations,
  getConversation,
  renameConversation,
  deleteConversation,
} from "@/lib/api";
import type {
  ChatMessage,
  Conversation,
  ConversationSummary,
  Source,
} from "@/types/chat";
import ChatSidebar from "./ChatSidebar";
import ChatMessages from "./ChatMessages";
import ChatComposer from "./ChatComposer";
import ChatEmptyState from "./ChatEmptyState";

interface ChatWorkspaceProps {
  initialConversationId?: string;
}

/** Replace the URL without triggering a Next.js navigation/remount. */
function syncUrl(id: string | null) {
  if (typeof window === "undefined") return;
  const path = id ? `/chat/${id}` : "/chat";
  if (window.location.pathname !== path) {
    window.history.replaceState(null, "", path);
  }
}

/** Render a conversation thread as a portable Markdown document. */
function conversationToMarkdown(convo: Conversation): string {
  const lines: string[] = [`# ${convo.title || "محادثة"}`, ""];
  for (const m of convo.messages) {
    lines.push(m.role === "user" ? "### 🧑 المستخدم" : "### 🤖 المساعد");
    lines.push("", m.content.trim(), "");
    if (m.role === "assistant" && m.sources?.length) {
      lines.push("**المصادر:**", "");
      m.sources.forEach((s, i) => {
        lines.push(`${i + 1}. ${s.title || s.doc_id} — \`${s.doc_id}\``);
      });
      lines.push("");
    }
    lines.push("---", "");
  }
  return lines.join("\n");
}

export default function ChatWorkspace({
  initialConversationId,
}: ChatWorkspaceProps) {
  const searchParams = useSearchParams();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(
    initialConversationId ?? null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingIndex, setStreamingIndex] = useState<number | null>(null);
  const [isRetrieving, setIsRetrieving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const seededRef = useRef(false);

  const rootQuery = messages.find((m) => m.role === "user")?.content;

  /* ── Conversation list ─────────────────────────────────────── */
  const refreshList = useCallback(async () => {
    try {
      const list = await listConversations();
      setConversations(list);
    } catch {
      /* sidebar stays as-is on transient errors */
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  /* ── Load a conversation thread ────────────────────────────── */
  const loadConversation = useCallback(
    async (id: string) => {
      abortRef.current?.abort();
      setStreaming(false);
      setStreamingIndex(null);
      setIsRetrieving(false);
      setError(null);
      setActiveId(id);
      setSidebarOpen(false);
      syncUrl(id);
      setLoadingThread(true);
      try {
        const convo = await getConversation(id);
        setMessages(convo.messages);
        // Focus the composer so the user can keep typing immediately.
        requestAnimationFrame(() => composerRef.current?.focus());
      } catch {
        setError("تعذّر تحميل المحادثة");
        setMessages([]);
      } finally {
        setLoadingThread(false);
      }
    },
    [],
  );

  // Load deep-linked conversation on first mount.
  useEffect(() => {
    if (initialConversationId) {
      loadConversation(initialConversationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Auto-scroll to bottom while streaming / on new messages ─ */
  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  /* ── New chat ──────────────────────────────────────────────── */
  const handleNewChat = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
    setStreamingIndex(null);
    setIsRetrieving(false);
    setActiveId(null);
    setMessages([]);
    setError(null);
    setInput("");
    setSidebarOpen(false);
    syncUrl(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  // Keyboard shortcuts: Ctrl/Cmd+Shift+O starts a new chat; "/" focuses the
  // composer when the user isn't already typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        handleNewChat();
        return;
      }
      if (e.key === "/" && !mod) {
        const el = e.target as HTMLElement | null;
        const tag = el?.tagName;
        const typing =
          tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable;
        if (!typing) {
          e.preventDefault();
          composerRef.current?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNewChat]);

  /* ── Streaming core (shared by send + regenerate) ──────────── */
  const streamInto = useCallback(
    (request: {
      conversation_id?: string;
      message: string;
      regenerate?: boolean;
      retrieve_top_k?: number;
    }) => {
      const controller = new AbortController();
      abortRef.current = controller;

      const updateAssistant = (mutator: (m: ChatMessage) => ChatMessage) => {
        setMessages((prev) => {
          const next = [...prev];
          const last = next.length - 1;
          if (last >= 0 && next[last].role === "assistant") {
            next[last] = mutator(next[last]);
          }
          return next;
        });
      };

      streamCorpusChat(
        request,
        {
          onConversationId: (id) => {
            setActiveId(id);
            syncUrl(id);
          },
          onToken: (token) => {
            setIsRetrieving(false);
            updateAssistant((m) => ({ ...m, content: m.content + token }));
          },
          onSources: (sources: Source[]) => {
            updateAssistant((m) => ({ ...m, sources }));
          },
          onDone: () => {
            setStreaming(false);
            setStreamingIndex(null);
            setIsRetrieving(false);
            abortRef.current = null;
            refreshList();
          },
          onError: (msg) => {
            setStreaming(false);
            setStreamingIndex(null);
            setIsRetrieving(false);
            abortRef.current = null;
            updateAssistant((m) => ({
              ...m,
              content:
                m.content || "تعذّر إكمال الإجابة. يرجى المحاولة مرة أخرى.",
            }));
            setError(msg);
          },
        },
        controller.signal,
      );
    },
    [refreshList],
  );

  /* ── Send a message ────────────────────────────────────────── */
  const handleSend = useCallback(
    (override?: string) => {
      const message = (override ?? input).trim();
      if (!message || streaming) return;

      setError(null);
      setInput("");

      const userMsg: ChatMessage = { role: "user", content: message };
      const assistantMsg: ChatMessage = { role: "assistant", content: "" };

      let assistantIndex = 0;
      setMessages((prev) => {
        assistantIndex = prev.length + 1;
        return [...prev, userMsg, assistantMsg];
      });
      setStreamingIndex(assistantIndex);
      setStreaming(true);
      setIsRetrieving(true);

      streamInto({ conversation_id: activeId ?? undefined, message });
    },
    [input, streaming, activeId, streamInto],
  );

  /* ── Regenerate the last answer (optionally with more sources) ─ */
  const handleRegenerate = useCallback(
    (retrieveTopK?: number) => {
      if (streaming || !activeId) return;
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUser) return;

      setError(null);

      let assistantIndex = 0;
      setMessages((prev) => {
        const next = [...prev];
        if (next.length && next[next.length - 1].role === "assistant") {
          next.pop();
        }
        assistantIndex = next.length;
        next.push({ role: "assistant", content: "" });
        return next;
      });
      setStreamingIndex(assistantIndex);
      setStreaming(true);
      setIsRetrieving(true);

      streamInto({
        conversation_id: activeId,
        message: lastUser.content,
        regenerate: true,
        retrieve_top_k: retrieveTopK,
      });
    },
    [streaming, activeId, messages, streamInto],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setStreamingIndex(null);
    setIsRetrieving(false);
    refreshList();
  }, [refreshList]);

  /* ── Seed from a search handoff (/chat?q=...) ──────────────── */
  useEffect(() => {
    if (seededRef.current || initialConversationId) return;
    const seed = searchParams.get("q")?.trim();
    if (!seed) return;
    seededRef.current = true;
    // Strip the query param so a refresh doesn't re-send the message.
    window.history.replaceState(null, "", "/chat");
    handleSend(seed);
  }, [searchParams, initialConversationId, handleSend]);

  /* ── Rename / delete ───────────────────────────────────────── */
  const handleRename = useCallback(async (id: string, title: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c)),
    );
    try {
      await renameConversation(id, title);
    } catch {
      refreshList();
    }
  }, [refreshList]);

  const handleDelete = useCallback(
    async (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === activeId) handleNewChat();
      try {
        await deleteConversation(id);
      } catch {
        refreshList();
      }
    },
    [activeId, handleNewChat, refreshList],
  );

  /* ── Export a conversation as Markdown ─────────────────────── */
  const handleExport = useCallback(async (id: string) => {
    try {
      const convo = await getConversation(id);
      const md = conversationToMarkdown(convo);
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(convo.title || "محادثة").replace(/[\\/:*?"<>|]/g, "_")}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("تعذّر تصدير المحادثة");
    }
  }, []);

  // Cleanup on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const hasMessages = messages.length > 0;

  return (
    <div className="flex h-svh overflow-hidden bg-bg-primary">
      {/* Sidebar — desktop */}
      <div className="hidden w-72 shrink-0 border-l border-border lg:block">
        <ChatSidebar
          conversations={conversations}
          activeId={activeId}
          loading={loadingList}
          onNewChat={handleNewChat}
          onSelect={loadConversation}
          onRename={handleRename}
          onDelete={handleDelete}
          onExport={handleExport}
        />
      </div>

      {/* Sidebar — mobile drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="absolute inset-y-0 right-0 w-72 border-l border-border shadow-xl">
            <ChatSidebar
              conversations={conversations}
              activeId={activeId}
              loading={loadingList}
              onNewChat={handleNewChat}
              onSelect={loadConversation}
              onRename={handleRename}
              onDelete={handleDelete}
              onExport={handleExport}
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Main pane */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex h-12 items-center justify-between border-b border-border px-3 lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            aria-label="المحادثات"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted hover:bg-bg-secondary"
          >
            <PanelLeft size={18} />
          </button>
          <span className="font-arabic text-[14px] font-semibold text-text-primary">
            محادثة المجموعة
          </span>
          <span className="w-9" />
        </div>

        {/* Thread */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {!hasMessages && !loadingThread ? (
            <ChatEmptyState onPick={(p) => handleSend(p)} />
          ) : (
            <div className="mx-auto w-full max-w-3xl px-4 py-8">
              {loadingThread ? (
                <div className="space-y-6">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="skeleton h-16 rounded-xl" />
                  ))}
                </div>
              ) : (
                <ChatMessages
                  messages={messages}
                  streamingIndex={streamingIndex}
                  isRetrieving={isRetrieving}
                  rootQuery={rootQuery}
                  onRegenerate={handleRegenerate}
                  canRegenerate={!streaming && activeId !== null}
                />
              )}
              <div ref={endRef} className="h-1" />
            </div>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-auto w-full max-w-3xl px-4">
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700 font-arabic">
              <AlertCircle size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          </div>
        )}

        {/* Composer */}
        <ChatComposer
          ref={composerRef}
          value={input}
          onChange={setInput}
          onSend={() => handleSend()}
          onStop={handleStop}
          streaming={streaming}
        />
      </main>
    </div>
  );
}
