"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sparkles, User, Copy, Check, Search, RefreshCw, Layers } from "lucide-react";
import type { ChatMessage, Source } from "@/types/chat";
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
  /** The user question this answer responds to — powers the "search this" action. */
  userQuery?: string;
  /** Re-answer the last turn. Provided only for the last assistant message. */
  onRegenerate?: (retrieveTopK?: number) => void;
  /** Whether regenerate controls should be active. */
  canRegenerate?: boolean;
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

/* ── Clickable citations ─────────────────────────────────────────────
 * The model wraps verbatim evidence in «guillemets» and may name a source
 * as (المستند [N]). We turn both into clickable links that deep-link into
 * the source document, where the existing viewer highlights the passage.
 */

/** Normalize Arabic text for tolerant substring matching (tashkeel + punctuation). */
function normalizeArabic(s: string): string {
  return s
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[.,،؛:؟!()[\]{}«»"'\-–—٪%/\\]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/**
 * Rewrite an answer's markdown so citations become links:
 *   «quote»          → [«quote»](#q-<i>)   (i indexes into the returned quotes[])
 *   (المستند [N])    → [المستند N](#s-N)
 * Returns the rewritten markdown plus the ordered list of raw quote strings.
 */
function prepareCitations(content: string): { md: string; quotes: string[] } {
  const quotes: string[] = [];
  // Source markers first, so the quote pass doesn't touch them.
  let md = content.replace(
    /\(\s*المستند\s*\[?\s*(\d+)\s*\]?\s*\)/g,
    (_m, n: string) => ` [المستند ${n}](#s-${n})`,
  );
  // Verbatim guillemet quotes.
  md = md.replace(/«([^»]+)»/g, (_m, q: string) => {
    const raw = q.trim();
    const i = quotes.length;
    quotes.push(raw);
    // Strip brackets from the visible text so markdown link parsing stays valid.
    const safe = raw.replace(/[[\]]/g, "");
    return `[«${safe}»](#q-${i})`;
  });
  return { md, quotes };
}

/** Pick the source document a quote came from (substring match, with fallback). */
function resolveDocId(quote: string, sources: Source[]): string | null {
  if (!sources.length) return null;
  const nq = normalizeArabic(quote);
  if (nq) {
    for (const s of sources) {
      if (s.text && normalizeArabic(s.text).includes(nq)) return s.doc_id;
    }
    for (const s of sources) {
      if (s.snippet && normalizeArabic(s.snippet).includes(nq)) return s.doc_id;
    }
  }
  return sources[0].doc_id; // fall back to the top-ranked source
}

/** Doc_ids whose text was actually quoted in the answer (strict, no fallback). */
function computeCitedDocIds(content: string, sources: Source[]): Set<string> {
  const ids = new Set<string>();
  if (!sources.length) return ids;
  const { quotes } = prepareCitations(content);
  for (const q of quotes) {
    const nq = normalizeArabic(q);
    if (!nq) continue;
    for (const s of sources) {
      const hay = s.text
        ? normalizeArabic(s.text)
        : s.snippet
          ? normalizeArabic(s.snippet)
          : "";
      if (hay && hay.includes(nq)) {
        ids.add(s.doc_id);
        break;
      }
    }
  }
  return ids;
}

interface CitedAnswerProps {
  content: string;
  sources: Source[];
}

/** Renders an assistant answer with clickable verbatim-quote / source citations. */
function CitedAnswer({ content, sources }: CitedAnswerProps) {
  const router = useRouter();

  const { md, quotes } = useMemo(() => prepareCitations(content), [content]);

  // Refs keep the custom link renderer identity stable across streaming
  // re-renders (avoids ReactMarkdown DOM reconciliation crashes), while still
  // reading the latest quotes/sources on click.
  const quotesRef = useRef(quotes);
  const sourcesRef = useRef(sources);
  const routerRef = useRef(router);
  useEffect(() => { quotesRef.current = quotes; }, [quotes]);
  useEffect(() => { sourcesRef.current = sources; }, [sources]);
  useEffect(() => { routerRef.current = router; }, [router]);

  const CitationLink = useMemo(
    () =>
      function CitationLinkInner({ href, children }: { href?: string; children?: ReactNode }) {
        if (href?.startsWith("#q-")) {
          const i = parseInt(href.slice(3), 10);
          return (
            <button
              type="button"
              title="افتح المصدر"
              onClick={(e) => {
                e.preventDefault();
                const quote = quotesRef.current[i];
                if (!quote) return;
                const docId = resolveDocId(quote, sourcesRef.current);
                if (!docId) return;
                routerRef.current.push(
                  `/document/${encodeURIComponent(docId)}?cite=${encodeURIComponent(quote)}`,
                );
              }}
              className="mx-px cursor-pointer rounded px-0.5 font-medium text-accent underline decoration-dotted decoration-accent/50 underline-offset-2 transition-colors hover:bg-accent/[0.06] hover:decoration-solid"
            >
              {children}
            </button>
          );
        }
        if (href?.startsWith("#s-")) {
          const n = parseInt(href.slice(3), 10);
          const src = sourcesRef.current[n - 1];
          return (
            <span className="group/cite relative inline-block align-baseline">
              <button
                type="button"
                title="افتح المستند"
                onClick={(e) => {
                  e.preventDefault();
                  if (!src) return;
                  routerRef.current.push(`/document/${encodeURIComponent(src.doc_id)}`);
                }}
                className="mx-0.5 inline-flex cursor-pointer items-center rounded bg-accent/[0.08] px-1.5 py-0.5 text-[11px] font-semibold text-accent no-underline transition-colors hover:bg-accent hover:text-white"
              >
                {children}
              </button>
              {src && (
                <span
                  dir="rtl"
                  className="pointer-events-none invisible absolute bottom-full right-0 z-50 mb-1.5 flex w-64 flex-col gap-1 rounded-xl border border-border bg-bg-elevated p-3 text-right opacity-0 shadow-lg transition-opacity duration-150 group-hover/cite:visible group-hover/cite:opacity-100"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-accent px-1 text-[10px] font-bold text-white" dir="ltr">{n}</span>
                    {src.section && (
                      <span className="rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-muted">{src.section}</span>
                    )}
                    {typeof src.score === "number" && (
                      <span className="ms-auto text-[10px] tabular-nums text-text-muted" dir="ltr">{src.score.toFixed(3)}</span>
                    )}
                  </span>
                  <span className="line-clamp-2 font-arabic text-[12px] font-semibold leading-snug text-text-primary">{src.title || src.doc_id}</span>
                  {(src.snippet || src.text) && (
                    <span className="line-clamp-3 font-arabic text-[11px] leading-relaxed text-text-muted">{src.snippet || src.text}</span>
                  )}
                  <span className="mt-0.5 text-[10px] text-accent">انقر لفتح المستند</span>
                </span>
              )}
            </span>
          );
        }
        return (
          <a href={href} target="_blank" rel="noreferrer" className="text-accent underline">
            {children}
          </a>
        );
      },
    [],
  );

  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: CitationLink }}>{md}</ReactMarkdown>;
}

/** Link button that jumps to structured Search for a question. */
function SearchButton({ query }: { query: string }) {
  const router = useRouter();
  return (
    <button
      onClick={() => router.push(`/search?q=${encodeURIComponent(query)}`)}
      aria-label="ابحث عن هذا"
      title="ابحث عن هذا"
      className="mt-2 flex items-center gap-1 rounded-md px-1.5 py-1 font-arabic text-[12px] text-text-muted transition hover:text-text-primary"
    >
      <Search size={14} />
      <span>ابحث عن هذا</span>
    </button>
  );
}

function AssistantMessage({ content, sources, streaming, retrieving, query, userQuery, onRegenerate, canRegenerate }: AssistantMessageProps) {
  const body = useMemo(
    () => <CitedAnswer content={content} sources={sources ?? []} />,
    [content, sources],
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
          <SourcesList
            sources={sources}
            query={query}
            citedDocIds={!streaming ? computeCitedDocIds(content, sources) : undefined}
          />
        )}
        {!streaming && content.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <CopyButton content={content} />
            {userQuery && <SearchButton query={userQuery} />}
            {onRegenerate && (
              <>
                <button
                  onClick={() => onRegenerate()}
                  disabled={!canRegenerate}
                  aria-label="إعادة توليد الإجابة"
                  title="إعادة توليد الإجابة"
                  className="mt-2 flex items-center gap-1 rounded-md px-1.5 py-1 font-arabic text-[12px] text-text-muted transition hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RefreshCw size={14} />
                  <span>إعادة توليد</span>
                </button>
                <button
                  onClick={() => onRegenerate(20)}
                  disabled={!canRegenerate}
                  aria-label="مزيد من المصادر"
                  title="إعادة الإجابة باستخدام مصادر أكثر"
                  className="mt-2 flex items-center gap-1 rounded-md px-1.5 py-1 font-arabic text-[12px] text-text-muted transition hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Layers size={14} />
                  <span>مزيد من المصادر</span>
                </button>
              </>
            )}
          </div>
        )}
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
  /** Re-answer the last turn (optionally with more sources). */
  onRegenerate?: (retrieveTopK?: number) => void;
  /** Whether regenerate controls should be active. */
  canRegenerate?: boolean;
}

export default function ChatMessages({
  messages,
  streamingIndex,
  isRetrieving,
  rootQuery,
  onRegenerate,
  canRegenerate,
}: ChatMessagesProps) {
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  })();

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
            userQuery={
              i > 0 && messages[i - 1].role === "user"
                ? messages[i - 1].content
                : undefined
            }
            onRegenerate={i === lastAssistantIndex ? onRegenerate : undefined}
            canRegenerate={canRegenerate}
          />
        ),
      )}
    </div>
  );
}
