"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  X,
  Loader2,
  Trash2,
  MessageSquare,
  Sparkles,
} from "lucide-react";

/* ── Types ──────────────────────────────────────────────────── */

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatPanelProps {
  docId: string;
  /** If true, renders as embedded panel (no fixed positioning) */
  embedded?: boolean;
  /** Called when user clicks X to close */
  onClose?: () => void;
  /** Callback when user clicks a «citation» in assistant text */
  onCitationClick?: (text: string) => void;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const SUGGESTED_QUESTIONS = [
  { text: "ما هي الفكرة الرئيسية لهذا البحث؟", icon: "📄" },
  { text: "ما المنهجية المستخدمة؟", icon: "🔬" },
  { text: "ما أبرز النتائج؟", icon: "📊" },
  { text: "ما هي التوصيات؟", icon: "💡" },
];

/* ── Component ──────────────────────────────────────────────── */

export default function ChatPanel({
  docId,
  embedded = false,
  onClose,
  onCitationClick,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // auto-scroll on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // focus input on mount
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 500);
    return () => clearTimeout(t);
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || streaming) return;

      const userMsg: Message = { role: "user", content: text.trim() };
      const history = [...messages, userMsg];
      setMessages(history);
      setInput("");
      setStreaming(true);

      // Placeholder assistant message for streaming
      const assistantMsg: Message = { role: "assistant", content: "" };
      setMessages([...history, assistantMsg]);

      try {
        const controller = new AbortController();
        abortRef.current = controller;

        const res = await fetch(`${API_BASE}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            doc_id: docId,
            message: text.trim(),
            history: messages,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const err = await res
            .json()
            .catch(() => ({ detail: res.statusText }));
          throw new Error(err.detail || `Chat failed: ${res.status}`);
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });
          const lines = text.split("\n");

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") break;

            try {
              const parsed = JSON.parse(payload);
              if (parsed.token) {
                accumulated += parsed.token;
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: accumulated,
                  };
                  return updated;
                });
              }
              if (parsed.error) {
                accumulated += `\n\n⚠️ Error: ${parsed.error}`;
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: accumulated,
                  };
                  return updated;
                });
              }
            } catch {
              // skip malformed JSON
            }
          }
        }
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: `⚠️ ${e instanceof Error ? e.message : "Something went wrong"}`,
          };
          return updated;
        });
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [docId, messages, streaming],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const clearChat = () => {
    if (streaming) {
      abortRef.current?.abort();
    }
    setMessages([]);
    setStreaming(false);
  };

  /** Render citation «text» as clickable spans */
  function renderContent(text: string) {
    const parts = text.split(/(«[^»]+»)/g);
    return parts.map((part, i) => {
      if (part.startsWith("«") && part.endsWith("»")) {
        const cited = part.slice(1, -1);
        return (
          <button
            key={i}
            onClick={() => onCitationClick?.(cited)}
            className="inline cursor-pointer rounded bg-accent/10 px-1 text-accent hover:bg-accent/20 transition-colors"
            title="Click to find in document"
          >
            «{cited}»
          </button>
        );
      }
      return <span key={i}>{part}</span>;
    });
  }

  /* ── Panel ──────────────────────────────────────────────────── */

  return (
    <div
      className={
        embedded
          ? "flex h-full flex-col bg-white font-arabic overscroll-contain"
          : "fixed bottom-0 right-0 top-0 z-50 flex w-[380px] flex-col border-l border-border bg-white shadow-xl font-arabic overscroll-contain"
      }
      style={{ overscrollBehavior: "contain" }}
    >
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/60 px-4 bg-gradient-to-l from-accent/[0.03] to-transparent">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10">
            <Sparkles size={15} className="text-accent" />
          </div>
          <div>
            <span className="text-sm font-semibold text-text-primary font-arabic">
              مساعد البحث
            </span>
            <p className="text-[10px] text-text-muted leading-none mt-0.5">
              GPT-4o Mini
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              className="rounded-md p-1.5 text-text-muted hover:bg-gray-100 hover:text-red-500 transition-colors"
              title="Clear chat"
            >
              <Trash2 size={14} />
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-text-muted hover:bg-gray-100 transition-colors"
              title="Close"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4 overscroll-contain"
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center pt-8 pb-4 animate-in fade-in duration-500">
            {/* Welcome icon */}
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/[0.07] mb-4">
              <MessageSquare size={28} className="text-accent" />
            </div>
            <h3 className="text-base font-semibold text-text-primary font-arabic mb-1">
              اسأل أي سؤال عن هذا المستند
            </h3>
            <p className="text-xs text-text-muted font-arabic mb-6 max-w-[260px] text-center">
              المساعد يحلل المستند الكامل ويجيب بناءً على محتواه فقط
            </p>
            <div className="w-full grid grid-cols-2 gap-2">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button
                  key={q.text}
                  onClick={() => sendMessage(q.text)}
                  className="group flex items-start gap-2 rounded-xl border border-border/60 px-3 py-2.5 text-right text-[13px] text-text-secondary hover:border-accent/30 hover:bg-accent/[0.03] transition-all duration-200 font-arabic"
                  dir="rtl"
                >
                  <span className="text-base leading-none mt-0.5 group-hover:scale-110 transition-transform">
                    {q.icon}
                  </span>
                  <span className="leading-snug">{q.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-start" : "justify-end"} animate-in slide-in-from-bottom-2 duration-200`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-accent text-white rounded-bl-md"
                  : "bg-gray-50 border border-border/40 text-text-primary rounded-br-md"
              }`}
              dir="auto"
            >
              {msg.role === "assistant"
                ? renderContent(msg.content)
                : msg.content}
              {msg.role === "assistant" &&
                streaming &&
                i === messages.length - 1 &&
                msg.content === "" && (
                  <div className="flex items-center gap-1.5 py-1">
                    <div className="flex gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent/50 animate-bounce [animation-delay:0ms]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-accent/50 animate-bounce [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-accent/50 animate-bounce [animation-delay:300ms]" />
                    </div>
                  </div>
                )}
              {msg.role === "assistant" &&
                streaming &&
                i === messages.length - 1 &&
                msg.content !== "" && (
                  <span className="inline-block w-1.5 h-4 bg-accent/60 animate-pulse ml-0.5 -mb-0.5 rounded-sm" />
                )}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border/60 p-3 bg-gray-50/50">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="اكتب سؤالك..."
            dir="auto"
            rows={1}
            className="flex-1 resize-none overflow-hidden rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/15 font-arabic transition-shadow"
            style={{ maxHeight: 120 }}
            onInput={(e) => {
              const t = e.currentTarget;
              t.style.height = "auto";
              t.style.height = Math.min(t.scrollHeight, 120) + "px";
            }}
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || streaming}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white disabled:opacity-30 hover:bg-accent-hover active:scale-95 transition-all"
          >
            {streaming ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Send size={16} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
