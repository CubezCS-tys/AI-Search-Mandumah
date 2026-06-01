"use client";

import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sparkles, User, Copy, Check } from "lucide-react";
import type { ChatMessage } from "@/types/chat";
import SourcesList from "./SourcesList";

const MARKDOWN_CLASSES =
  "prose prose-sm max-w-none font-arabic text-[14.5px] leading-relaxed text-text-primary [direction:rtl] " +
  "[&_h1]:text-[16px] [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2 " +
  "[&_h2]:text-[15px] [&_h2]:font-bold [&_h2]:mt-4 [&_h2]:mb-2 " +
  "[&_h3]:text-[14px] [&_h3]:font-bold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-text-primary " +
  "[&_p]:mb-3 [&_p]:leading-[1.9] [&_ul]:mt-1 [&_ul]:mb-3 [&_ol]:mt-1 [&_ol]:mb-3 " +
  "[&_li]:mb-1.5 [&_li]:leading-[1.85] [&_strong]:text-text-primary [&_strong]:font-bold " +
  "[&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-bg-primary [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px] " +
  "[&_table]:my-3 [&_th]:border [&_th]:border-border [&_th]:bg-bg-primary [&_th]:px-2 [&_th]:py-1 " +
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 " +
  "[&_blockquote]:border-r-2 [&_blockquote]:border-accent/30 [&_blockquote]:pr-3 [&_blockquote]:text-text-secondary";

interface AssistantMessageProps {
  content: string;
  sources?: ChatMessage["sources"];
  streaming?: boolean;
  retrieving?: boolean;
  query?: string;
}

/** Subtle "searching the corpus" status row shown before the first token. */
function RetrievalStatus() {
  return (
    <div className="flex items-center gap-2 font-arabic text-[13px] text-text-muted">
      <span className="flex items-center gap-1" aria-hidden>
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" />
      </span>
      <span>يبحث في المصادر…</span>
    </div>
  );
}

/** Icon-only copy button with transient "copied" feedback. */
function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — silently ignore */
    }
  };

  return (
    <button
      onClick={handleCopy}
      aria-label="نسخ"
      className="mt-2 flex items-center gap-1 rounded-md px-1.5 py-1 font-arabic text-[12px] text-text-muted transition hover:text-text-primary"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied && <span>تم النسخ</span>}
    </button>
  );
}

function AssistantMessage({ content, sources, streaming, retrieving, query }: AssistantMessageProps) {
  // Memoize the markdown body so the parsed tree is stable across re-renders
  // (only re-parses when content changes), avoiding reconciliation crashes.
  const body = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    ),
    [content],
  );

  const showRetrieval = retrieving && content.length === 0;

  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/[0.08]">
        <Sparkles size={15} className="text-accent" />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        {showRetrieval ? (
          <RetrievalStatus />
        ) : (
          <div className={MARKDOWN_CLASSES}>
            {body}
            {streaming && (
              <span className="ms-0.5 inline-block h-4 w-0.5 animate-pulse bg-accent align-middle" />
            )}
          </div>
        )}
        {sources && sources.length > 0 && (
          <SourcesList sources={sources} query={query} />
        )}
        {!streaming && content.length > 0 && <CopyButton content={content} />}
      </div>
    </div>
  );
}

function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end gap-3">
      <div className="max-w-[80%] rounded-2xl rounded-tr-md bg-accent px-4 py-2.5 text-white shadow-sm">
        <p className="whitespace-pre-wrap font-arabic text-[14.5px] leading-relaxed">
          {content}
        </p>
      </div>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-elevated border border-border">
        <User size={15} className="text-text-muted" />
      </div>
    </div>
  );
}

interface ChatMessagesProps {
  messages: ChatMessage[];
  /** Index of the message currently being streamed, if any. */
  streamingIndex?: number | null;
  /** True while the corpus is being searched, before the first token arrives. */
  isRetrieving?: boolean;
  /** First user message — used as the query for source highlight links. */
  rootQuery?: string;
}

export default function ChatMessages({
  messages,
  streamingIndex,
  isRetrieving,
  rootQuery,
}: ChatMessagesProps) {
  return (
    <div className="flex flex-col gap-7">
      {messages.map((m, i) =>
        m.role === "user" ? (
          <UserMessage key={i} content={m.content} />
        ) : (
          <AssistantMessage
            key={i}
            content={m.content}
            sources={m.sources}
            streaming={streamingIndex === i}
            retrieving={streamingIndex === i && isRetrieving}
            query={rootQuery}
          />
        ),
      )}
    </div>
  );
}
