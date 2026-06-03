"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Send,
  X,
  Trash2,
  MessageSquare,
  Sparkles,
  Copy,
  Check,
  Download,
  Square,
  FileText,
  GitCompareArrows,
  RefreshCw,
  ArrowUp,
  BookOpen,
  FlaskConical,
  BarChart3,
  Lightbulb,
  ClipboardList,
  Library,
  FileSearch,
  BookMarked,
  Target,
  Layers,
  ShieldCheck,
  AlertTriangle,
  Compass,
  type LucideIcon,
} from "lucide-react";

/* ── Types ──────────────────────────────────────────────────── */

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatPanelProps {
  docId: string;
  embedded?: boolean;
  onClose?: () => void;
  onCitationClick?: (text: string) => void;
  selectedText?: string | null;
  onSelectedTextConsumed?: () => void;
  onAnalyzingChange?: (analyzing: boolean) => void;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/* ── Analysis types ────────────────────────────────────────── */

interface Insight {
  icon: string;
  label: string;
  text: string;
  quote: string;
}

interface AnalysisResult {
  title?: string;
  authors?: string;
  summary?: string;
  methodology?: string;
  insights: Insight[];
}

const INSIGHT_ICONS: Record<string, LucideIcon> = {
  "target": Target,
  "bar-chart": BarChart3,
  "layers": Layers,
  "shield-check": ShieldCheck,
  "alert-triangle": AlertTriangle,
  "compass": Compass,
};

function getInsightKey(docId: string) {
  return `doc_analysis_${docId}`;
}

function loadCachedAnalysis(docId: string): AnalysisResult | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(getInsightKey(docId));
    if (stored) return JSON.parse(stored);
  } catch { /* corrupted */ }
  return null;
}

function saveCachedAnalysis(docId: string, data: AnalysisResult) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getInsightKey(docId), JSON.stringify(data));
  } catch { /* full */ }
}

const SUGGESTED_QUESTIONS: { text: string; icon: LucideIcon }[] = [
  { text: "ما هي الفكرة الرئيسية لهذا البحث؟", icon: BookOpen },
  { text: "ما المنهجية المستخدمة؟", icon: FlaskConical },
  { text: "ما أبرز النتائج؟", icon: BarChart3 },
  { text: "ما هي التوصيات؟", icon: Lightbulb },
];

const EXTRACTION_TEMPLATES: { text: string; label: string; icon: LucideIcon }[] = [
  { text: "استخرج جدول المنهجية المستخدمة في البحث", label: "جدول المنهجية", icon: ClipboardList },
  { text: "استخرج قائمة المراجع والمصادر المذكورة في البحث", label: "قائمة المراجع", icon: Library },
  { text: "أنشئ تقريراً مصغراً عن هذا البحث يتضمن: العنوان، المؤلفين، السنة، المنهجية، النتائج الرئيسية، ونقاط القوة والضعف", label: "تقرير مصغر", icon: FileSearch },
  { text: "استخرج جميع المصطلحات والتعريفات الرئيسية الواردة في البحث", label: "مصطلحات وتعريفات", icon: BookMarked },
];

/* ── Token estimation ──────────────────────────────────────── */

/** Rough token estimate: ~3 chars per token for Arabic */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** GPT-4o-mini pricing (per 1M tokens) */
const COST_PER_1M_INPUT = 0.15;
const COST_PER_1M_OUTPUT = 0.60;

function formatCost(inputTokens: number, outputTokens: number): string {
  const cost = (inputTokens * COST_PER_1M_INPUT + outputTokens * COST_PER_1M_OUTPUT) / 1_000_000;
  if (cost < 0.001) return "<$0.001";
  return `~$${cost.toFixed(3)}`;
}

/* ── localStorage persistence ──────────────────────────────── */

function getChatKey(docId: string) {
  return `chat_history_${docId}`;
}

function loadChatHistory(docId: string): Message[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(getChatKey(docId));
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // corrupted data
  }
  return [];
}

function saveChatHistory(docId: string, messages: Message[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getChatKey(docId), JSON.stringify(messages));
  } catch {
    // storage full
  }
}

/* ── Analyzing hero ─────────────────────────────────────────── */

const ANALYSIS_STEPS = [
  { icon: FileSearch, label: "قراءة المستند", delay: 0 },
  { icon: Layers, label: "تحليل البنية والمنهجية", delay: 2800 },
  { icon: Target, label: "استخراج الأفكار الرئيسية", delay: 5600 },
  { icon: Lightbulb, label: "تكوين الرؤى المعمّقة", delay: 8400 },
] as const;

function AnalyzingHero() {
  const [visibleSteps, setVisibleSteps] = useState(0);
  const [statusIdx, setStatusIdx] = useState(0);

  const STATUS_LABELS = [
    "يقرأ المحتوى بعمق...",
    "يحلل المنهجية والبيانات...",
    "يستخرج النتائج والتوصيات...",
    "يكوّن رؤى معمّقة حول البحث...",
  ];

  useEffect(() => {
    const timers = ANALYSIS_STEPS.map((step, i) =>
      setTimeout(() => setVisibleSteps(i + 1), step.delay)
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setStatusIdx((prev) => (prev + 1) % STATUS_LABELS.length);
    }, 2800);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col items-center pt-6 pb-6">
      {/* Central orb */}
      <div className="relative flex h-24 w-24 items-center justify-center mb-6">
        {/* Outermost pulse rings */}
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="absolute inset-0 rounded-full"
            style={{
              border: "1px solid rgba(155,27,48,0.12)",
              animation: `analysis-hero-ring 3s ease-out ${i * 1}s infinite`,
            }}
          />
        ))}
        {/* Rotating arc */}
        <div
          className="absolute inset-1 rounded-full"
          style={{
            border: "2px solid transparent",
            borderTopColor: "rgba(155,27,48,0.3)",
            borderRightColor: "rgba(155,27,48,0.1)",
            animation: "analysis-hero-spin 2.5s linear infinite",
          }}
        />
        {/* Counter-rotating inner arc */}
        <div
          className="absolute rounded-full"
          style={{
            inset: 10,
            border: "1.5px solid transparent",
            borderBottomColor: "rgba(155,27,48,0.2)",
            borderLeftColor: "rgba(155,27,48,0.08)",
            animation: "analysis-hero-spin 2s linear infinite reverse",
          }}
        />
        {/* Glowing core */}
        <div
          className="relative flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-accent/15 to-accent/5"
          style={{ animation: "analysis-glow 2.5s ease-in-out infinite" }}
        >
          <Sparkles size={20} className="text-accent" />
        </div>
        {/* Orbiting particles */}
        {[0, 1, 2, 3].map((i) => (
          <div
            key={`p${i}`}
            className="absolute top-1/2 left-1/2"
            style={{
              width: 0,
              height: 0,
              animation: `analysis-orbit ${2.8 + i * 0.4}s linear ${i * 0.5}s infinite${i % 2 ? " reverse" : ""}`,
            }}
          >
            <div
              className="rounded-full bg-accent"
              style={{
                width: 3 - i * 0.5,
                height: 3 - i * 0.5,
                opacity: 0.6 - i * 0.1,
              }}
            />
          </div>
        ))}
      </div>

      {/* Title */}
      <h3 className="text-[15px] font-bold text-text-primary font-arabic mb-1">
        تحليل ذكي للمستند
      </h3>

      {/* Cycling status text */}
      <p
        key={statusIdx}
        className="text-xs text-accent/70 font-arabic animate-in fade-in slide-in-from-bottom-1 duration-300"
      >
        {STATUS_LABELS[statusIdx]}
      </p>

      {/* Step progress */}
      <div className="w-full max-w-[280px] mt-6 space-y-2">
        {ANALYSIS_STEPS.map((step, i) => {
          const visible = i < visibleSteps;
          const active = i === visibleSteps - 1;
          const Icon = step.icon;
          return (
            <div
              key={i}
              className={`flex items-center gap-2.5 rounded-xl px-3 py-2 transition-all duration-500 ${
                visible
                  ? "opacity-100 translate-y-0"
                  : "opacity-0 translate-y-2 pointer-events-none"
              } ${
                active
                  ? "bg-accent/[0.06] border border-accent/20"
                  : "bg-transparent border border-transparent"
              }`}
            >
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-500 ${
                  active ? "bg-accent/15" : "bg-bg-secondary"
                }`}
              >
                {active ? (
                  <div className="h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                ) : visible ? (
                  <svg className="text-accent" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                ) : (
                  <Icon size={13} className="text-text-muted" />
                )}
              </div>
              <span
                className={`text-[12.5px] font-arabic transition-colors duration-500 ${
                  active ? "text-text-primary font-medium" : "text-text-muted"
                }`}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Component ──────────────────────────────────────────────── */

export default function ChatPanel({
  docId,
  embedded = false,
  onClose,
  onCitationClick,
  selectedText,
  onSelectedTextConsumed,
  onAnalyzingChange,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>(() => loadChatHistory(docId));
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(() => loadCachedAnalysis(docId));
  const [analyzing, setAnalyzing] = useState(false);
  const analyzingTriggered = useRef(false);
  const [compareDocIds, setCompareDocIds] = useState<string[]>([]);
  const [compareInput, setCompareInput] = useState("");
  const [showCompare, setShowCompare] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const prevDocIdRef = useRef(docId);

  // Reset all state when docId changes (navigating to a different document)
  useEffect(() => {
    if (prevDocIdRef.current !== docId) {
      prevDocIdRef.current = docId;
      setMessages(loadChatHistory(docId));
      setAnalysis(loadCachedAnalysis(docId));
      setAnalyzing(false);
      analyzingTriggered.current = false;
      setInput("");
      setStreaming(false);
      setShowTemplates(false);
      setCompareDocIds([]);
      setCompareInput("");
      setShowCompare(false);
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [docId]);

  // Track token usage for current session
  const sessionTokens = useMemo(() => {
    let inp = 0;
    let out = 0;
    for (const msg of messages) {
      const tokens = estimateTokens(msg.content);
      if (msg.role === "user") inp += tokens;
      else out += tokens;
    }
    return { input: inp, output: out };
  }, [messages]);

  // Persist messages to localStorage when not streaming
  useEffect(() => {
    if (!streaming && messages.length > 0) {
      saveChatHistory(docId, messages);
    }
  }, [messages, streaming, docId]);

  // Handle selected text from document
  useEffect(() => {
    if (selectedText && selectedText.trim()) {
      const prefill = `اشرح هذا النص: «${selectedText.trim()}»`;
      setInput(prefill);
      onSelectedTextConsumed?.();
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [selectedText, onSelectedTextConsumed]);

  // auto-scroll on new content
  useEffect(() => {
    if (streaming) {
      // During streaming, instant scroll to keep up
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    } else {
      // After streaming, smooth scroll
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streaming]);

  // focus input on mount
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 500);
    return () => clearTimeout(t);
  }, []);

  // Auto-analyze document on first open (when no chat history and no cached analysis)
  useEffect(() => {
    if (analyzingTriggered.current) return;
    // Check current state via refs/localStorage to avoid dependency issues
    const cachedAnalysis = loadCachedAnalysis(docId);
    if (cachedAnalysis) {
      setAnalysis(cachedAnalysis);
      return;
    }
    const history = loadChatHistory(docId);
    if (history.length > 0) return; // has chat history, skip

    analyzingTriggered.current = true;

    // Store controller on the ref so we can abort on docId change,
    // but don't abort in the effect cleanup (React Strict Mode runs effects twice)
    const controller = new AbortController();
    abortRef.current = controller;
    setAnalyzing(true);
    onAnalyzingChange?.(true);

    fetch(`${API_BASE}/api/analyze/${docId}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: AnalysisResult) => {
        setAnalysis(data);
        saveCachedAnalysis(docId, data);
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        console.warn("[ChatPanel] analyze failed:", e);
      })
      .finally(() => {
        setAnalyzing(false);
        onAnalyzingChange?.(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const sendMessage = useCallback(
    async (text: string, overrideHistory?: Message[]) => {
      if (!text.trim() || streaming) return;

      const apiHistory = overrideHistory ?? messages;
      const userMsg: Message = { role: "user", content: text.trim() };
      const uiMessages = [...apiHistory, userMsg];
      setMessages(uiMessages);
      setInput("");
      setStreaming(true);

      // Reset textarea height
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }

      // Placeholder assistant message for streaming
      const assistantMsg: Message = { role: "assistant", content: "" };
      setMessages([...uiMessages, assistantMsg]);

      try {
        const controller = new AbortController();
        abortRef.current = controller;

        const res = await fetch(`${API_BASE}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            doc_id: docId,
            message: text.trim(),
            history: apiHistory,
            compare_doc_ids: compareDocIds,
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
        let sseBuffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split("\n");
          // Keep the last (possibly incomplete) line in the buffer
          sseBuffer = lines.pop() || "";

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
                accumulated += `\n\n⚠️ ${parsed.error}`;
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
        if (e instanceof DOMException && e.name === "AbortError") {
          // Keep partial content when user stops generation
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant" && last.content === "") {
              return updated.slice(0, -1);
            }
            return updated;
          });
          return;
        }
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
    [docId, messages, streaming, compareDocIds],
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const regenerateLastResponse = useCallback(() => {
    if (streaming || messages.length < 2) return;
    const lastIdx = messages.length - 1;
    if (messages[lastIdx].role !== "assistant") return;
    const userIdx = lastIdx - 1;
    if (messages[userIdx]?.role !== "user") return;
    const lastUserText = messages[userIdx].content;
    const baseHistory = messages.slice(0, -2);
    sendMessage(lastUserText, baseHistory);
  }, [messages, streaming, sendMessage]);

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
    localStorage.removeItem(getChatKey(docId));
  };

  const copyMessage = useCallback(async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for environments without clipboard API
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  }, []);

  const exportChat = useCallback(() => {
    if (messages.length === 0) return;

    let md = `# محادثة مع المستند\n\n`;
    md += `**معرف المستند:** ${docId}\n`;
    md += `**التاريخ:** ${new Date().toLocaleDateString("ar-SA")}\n\n---\n\n`;

    for (const msg of messages) {
      if (msg.role === "user") {
        md += `## 🧑 المستخدم\n\n${msg.content}\n\n`;
      } else {
        md += `## 🤖 المساعد\n\n${msg.content}\n\n`;
      }
      md += `---\n\n`;
    }

    md += `\n*تم التصدير من منصة المنظومة*\n`;

    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${docId}-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [messages, docId]);

  /** Shared markdown component config */
  const mdComponents: Record<string, React.ComponentType<Record<string, unknown>>> = useMemo(() => ({
    p: ({ children }: { children?: React.ReactNode }) => <span className="block mb-2 last:mb-0">{children}</span>,
    h1: ({ children }: { children?: React.ReactNode }) => <h3 className="text-base font-bold mt-3 mb-1.5">{children}</h3>,
    h2: ({ children }: { children?: React.ReactNode }) => <h4 className="text-sm font-bold mt-2.5 mb-1">{children}</h4>,
    h3: ({ children }: { children?: React.ReactNode }) => <h4 className="text-sm font-semibold mt-2 mb-1">{children}</h4>,
    ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc list-inside my-1.5 space-y-0.5">{children}</ul>,
    ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal list-inside my-1.5 space-y-0.5">{children}</ol>,
    li: ({ children }: { children?: React.ReactNode }) => <li className="text-sm">{children}</li>,
    strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-bold">{children}</strong>,
    em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
    code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
      const isBlock = className?.includes("language-");
      if (isBlock) {
        return (
          <pre className="bg-bg-secondary rounded-lg p-2.5 my-2 overflow-x-auto text-xs" dir="ltr">
            <code>{children}</code>
          </pre>
        );
      }
      return <code className="bg-bg-secondary rounded px-1 py-0.5 text-xs" dir="ltr">{children}</code>;
    },
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
      <a href={href} className="text-accent underline">{children}</a>
    ),
    table: ({ children }: { children?: React.ReactNode }) => (
      <div className="overflow-x-auto my-2">
        <table className="min-w-full text-xs border-collapse border border-border/40">{children}</table>
      </div>
    ),
    th: ({ children }: { children?: React.ReactNode }) => <th className="border border-border/40 bg-bg-secondary px-2 py-1 text-right font-semibold">{children}</th>,
    td: ({ children }: { children?: React.ReactNode }) => <td className="border border-border/40 px-2 py-1">{children}</td>,
    blockquote: ({ children }: { children?: React.ReactNode }) => (
      <blockquote className="border-r-2 border-accent/40 pr-3 my-2 text-text-secondary italic">{children}</blockquote>
    ),
    hr: () => <hr className="my-3 border-border/30" />,
  }), []);

  /** Inline variant — p renders as inline span so citations flow in prose */
  const inlineMdComponents: Record<string, React.ComponentType<Record<string, unknown>>> = useMemo(() => ({
    ...mdComponents,
    p: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  }), [mdComponents]);

  /** Merge adjacent «a» connector «b» → «a connector b» */
  function mergeCitations(rawParts: string[]): string[] {
    const merged: string[] = [];
    for (let i = 0; i < rawParts.length; i++) {
      const isCit = rawParts[i].startsWith("«") && rawParts[i].endsWith("»");
      if (
        isCit &&
        merged.length >= 2 &&
        merged[merged.length - 2].startsWith("«") && merged[merged.length - 2].endsWith("»")
      ) {
        const gap = merged[merged.length - 1];
        if (/^\s*[،,]?\s*(?:و|أو|ثم|في|من|إلى|على|عن|مع|بين|بل|لا|لم|هو|هي|أن|إن|كان|كما|حيث|لكن)?\s*$/.test(gap) && gap.trim().length <= 5) {
          const prev = merged[merged.length - 2];
          merged.pop();
          merged.pop();
          const prevText = prev.slice(1, -1);
          const curText = rawParts[i].slice(1, -1);
          merged.push(`«${prevText}${gap}${curText}»`);
          continue;
        }
      }
      merged.push(rawParts[i]);
    }
    return merged;
  }

  /** Render content with markdown and clickable citations */
  function renderContent(text: string) {
    // Split into paragraph-level blocks (double newlines)
    const blocks = text.split(/\n\n+/);

    return blocks.map((block, bIdx) => {
      const trimmed = block.trim();
      if (!trimmed) return null;

      // No citations → full markdown with block-level elements
      if (!trimmed.includes("«")) {
        return (
          <ReactMarkdown
            key={bIdx}
            remarkPlugins={[remarkGfm]}
            components={mdComponents}
          >
            {trimmed}
          </ReactMarkdown>
        );
      }

      // Has citations → split, merge, render inline
      const rawParts = trimmed.split(/(«[^»]+»)/g);
      const merged = mergeCitations(rawParts);

      return (
        <span key={bIdx} className="block mb-2 last:mb-0">
          {merged.map((part, i) => {
            if (part.startsWith("«") && part.endsWith("»")) {
              const cited = part.slice(1, -1);
              return (
                <button
                  key={i}
                  onClick={() => onCitationClick?.(cited)}
                  className="inline cursor-pointer rounded-md border border-accent/25 bg-accent/[0.08] px-1.5 py-0.5 text-accent font-medium hover:bg-accent/20 hover:border-accent/40 transition-colors"
                  title="اضغط للعثور عليه في المستند"
                >
                  «{cited}»
                </button>
              );
            }
            if (!part.trim()) return null;
            return (
              <ReactMarkdown
                key={i}
                remarkPlugins={[remarkGfm]}
                components={inlineMdComponents}
              >
                {part}
              </ReactMarkdown>
            );
          })}
        </span>
      );
    });
  }

  /* ── Panel ──────────────────────────────────────────────────── */

  return (
    <div
      className={
        embedded
          ? "flex h-full flex-col bg-bg-elevated font-arabic overscroll-contain"
          : "fixed bottom-0 right-0 top-0 z-50 flex w-[380px] flex-col border-l border-border bg-bg-elevated shadow-xl font-arabic overscroll-contain"
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
            <>
              <button
                onClick={exportChat}
                className="rounded-md p-1.5 text-text-muted hover:bg-bg-secondary hover:text-accent transition-colors"
                title="تصدير المحادثة"
              >
                <Download size={14} />
              </button>
              <button
                onClick={clearChat}
                className="rounded-md p-1.5 text-text-muted hover:bg-bg-secondary hover:text-red-500 transition-colors"
                title="مسح المحادثة"
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
          <button
            onClick={() => setShowCompare((v) => !v)}
            className={`rounded-md p-1.5 transition-colors ${
              showCompare || compareDocIds.length > 0
                ? "text-blue-600 bg-blue-50 hover:bg-blue-100"
                : "text-text-muted hover:bg-bg-secondary"
            }`}
            title="مقارنة مع مستندات أخرى"
          >
            <GitCompareArrows size={14} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-text-muted hover:bg-bg-secondary transition-colors"
              title="إغلاق"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Compare documents bar */}
      {showCompare && (
        <div className="shrink-0 border-b border-border/40 px-3 py-2 bg-blue-50/50 animate-in slide-in-from-top-1 duration-200">
          <div className="flex items-center gap-2 mb-1.5">
            <input
              value={compareInput}
              onChange={(e) => setCompareInput(e.target.value)}
              placeholder="أدخل معرف المستند (مثل: 0013-034-001-001)"
              dir="ltr"
              className="flex-1 rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs focus:border-accent/50 focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && compareInput.trim()) {
                  const id = compareInput.trim();
                  if (/^\d{4}-\d{3}-\d{3}-\d{3}$/.test(id) && !compareDocIds.includes(id) && id !== docId && compareDocIds.length < 3) {
                    setCompareDocIds((prev) => [...prev, id]);
                    setCompareInput("");
                  }
                }
              }}
            />
            <button
              onClick={() => {
                const id = compareInput.trim();
                if (/^\d{4}-\d{3}-\d{3}-\d{3}$/.test(id) && !compareDocIds.includes(id) && id !== docId && compareDocIds.length < 3) {
                  setCompareDocIds((prev) => [...prev, id]);
                  setCompareInput("");
                }
              }}
              className="rounded-md bg-accent/10 px-2 py-1 text-xs text-accent hover:bg-accent/20 transition-colors"
            >
              إضافة
            </button>
          </div>
          {compareDocIds.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {compareDocIds.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] text-blue-700" dir="ltr">
                  {id}
                  <button
                    onClick={() => setCompareDocIds((prev) => prev.filter((d) => d !== id))}
                    className="hover:text-red-500 transition-colors"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <p className="text-[10px] text-text-muted mt-1 font-arabic">حتى 3 مستندات إضافية للمقارنة</p>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4 overscroll-contain"
      >
        {messages.length === 0 && (
          <div className="flex flex-col pt-4 pb-4 animate-in fade-in duration-500">
            {/* Analyzing state */}
            {analyzing && !analysis && (
              <AnalyzingHero />
            )}

            {/* Analysis results — insight cards */}
            {analysis && (
              <div className="space-y-3 animate-in fade-in slide-in-from-bottom-3 duration-500">
                {/* Document header */}
                <div className="rounded-xl bg-gradient-to-l from-accent/[0.06] to-transparent border border-border/40 p-3">
                  <h3 className="text-sm font-bold text-text-primary font-arabic leading-snug mb-1 line-clamp-2" dir="auto">
                    {analysis.title || "بدون عنوان"}
                  </h3>
                  {analysis.authors && (
                    <p className="text-[11px] text-text-muted font-arabic mb-2" dir="auto">{analysis.authors}</p>
                  )}
                  {analysis.summary && (
                    <p className="text-xs text-text-secondary font-arabic leading-relaxed" dir="auto">{analysis.summary}</p>
                  )}
                  {analysis.methodology && (
                    <div className="mt-2 flex items-start gap-1.5">
                      <FlaskConical size={12} className="text-accent/60 mt-0.5 shrink-0" />
                      <p className="text-[11px] text-text-muted font-arabic" dir="auto">{analysis.methodology}</p>
                    </div>
                  )}
                </div>

                {/* Insight cards */}
                <div className="space-y-2">
                  {analysis.insights?.map((insight, idx) => {
                    const IconComp = INSIGHT_ICONS[insight.icon] || Sparkles;
                    return (
                      <button
                        key={idx}
                        onClick={() => {
                          // Click navigates to the citation in the document
                          if (insight.quote) {
                            onCitationClick?.(insight.quote);
                          }
                        }}
                        className="group w-full rounded-xl border border-border/50 p-3 text-right hover:border-accent/30 hover:bg-accent/[0.02] transition-all duration-200 font-arabic"
                        dir="rtl"
                      >
                        <div className="flex items-start gap-2.5">
                          <div className="shrink-0 mt-0.5 flex h-7 w-7 items-center justify-center rounded-lg bg-accent/[0.08] group-hover:bg-accent/15 transition-colors">
                            <IconComp size={14} className="text-accent" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-semibold text-text-primary leading-snug">{insight.label}</p>
                            <p className="text-xs text-text-secondary leading-relaxed mt-0.5">{insight.text}</p>
                            {insight.quote && (
                              <p className="text-[11px] text-accent/70 mt-1.5 leading-relaxed line-clamp-2 bg-accent/[0.04] rounded-lg px-2 py-1">
                                «{insight.quote}»
                              </p>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Quick actions below insights */}
                <div className="pt-2 border-t border-border/30">
                  <p className="text-[11px] text-text-muted font-arabic mb-2">أو اسأل سؤالاً مباشراً:</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {SUGGESTED_QUESTIONS.map((q) => (
                      <button
                        key={q.text}
                        onClick={() => sendMessage(q.text)}
                        className="group flex items-center gap-1.5 rounded-lg border border-border/40 px-2.5 py-2 text-right text-[12px] text-text-secondary hover:border-accent/30 hover:bg-accent/[0.03] transition-all duration-200 font-arabic"
                        dir="rtl"
                      >
                        <q.icon size={13} className="text-accent/60 shrink-0" />
                        <span className="leading-snug truncate">{q.text}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Extraction templates */}
                <div>
                  <button
                    onClick={() => setShowTemplates((v) => !v)}
                    className="flex items-center gap-1.5 text-xs text-text-muted hover:text-accent transition-colors mb-2 font-arabic"
                  >
                    <FileText size={12} />
                    <span>قوالب استخراج جاهزة</span>
                    <span className="text-[10px]">{showTemplates ? "▲" : "▼"}</span>
                  </button>
                  {showTemplates && (
                    <div className="grid grid-cols-2 gap-1.5 animate-in slide-in-from-top-2 duration-200">
                      {EXTRACTION_TEMPLATES.map((t) => (
                        <button
                          key={t.label}
                          onClick={() => sendMessage(t.text)}
                          className="group flex items-center gap-1.5 rounded-lg border border-accent/20 bg-accent/[0.02] px-2.5 py-2 text-right text-[12px] text-text-secondary hover:border-accent/40 hover:bg-accent/[0.06] transition-all duration-200 font-arabic"
                          dir="rtl"
                        >
                          <t.icon size={13} className="text-accent/60 shrink-0" />
                          <span className="leading-snug truncate">{t.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Fallback: no analysis — polished empty state with suggested questions */}
            {!analysis && !analyzing && (
              <div className="flex flex-col items-center pt-6 pb-4 animate-in fade-in duration-500">
                {/* Orb icon */}
                <div className="relative flex h-20 w-20 items-center justify-center mb-5">
                  <div
                    className="absolute inset-0 rounded-full border border-accent/15"
                    style={{ animation: "analysis-ring 3s ease-in-out infinite" }}
                  />
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-accent/12 to-accent/[0.03]">
                    <MessageSquare size={24} className="text-accent" />
                  </div>
                </div>

                <h3 className="text-[15px] font-bold text-text-primary font-arabic mb-1">
                  اسأل أي سؤال عن المستند
                </h3>
                <p className="text-xs text-text-muted font-arabic mb-6 max-w-[260px] text-center leading-relaxed">
                  المساعد يحلل المستند الكامل ويجيب بناءً على محتواه
                </p>

                {/* Question cards — 2-col grid */}
                <div className="w-full grid grid-cols-2 gap-2 mb-4">
                  {SUGGESTED_QUESTIONS.map((q, i) => (
                    <button
                      key={q.text}
                      onClick={() => sendMessage(q.text)}
                      className="group flex items-center gap-2 rounded-xl border border-border/50 px-3 py-2.5 text-right text-[12.5px] text-text-secondary hover:border-accent/30 hover:bg-accent/[0.04] hover:shadow-sm transition-all duration-200 font-arabic animate-in fade-in slide-in-from-bottom-2"
                      style={{ animationDelay: `${i * 80}ms`, animationFillMode: "both" }}
                      dir="rtl"
                    >
                      <span className="shrink-0 flex h-7 w-7 items-center justify-center rounded-lg bg-accent/[0.06] group-hover:bg-accent/12 transition-colors">
                        <q.icon size={14} className="text-accent/70" />
                      </span>
                      <span className="leading-snug">{q.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {messages.map((msg, i) => {
          const isLast = i === messages.length - 1;
          const isActiveStream = streaming && isLast && msg.role === "assistant";

          if (msg.role === "user") {
            return (
              <div key={i} className="flex justify-end animate-in fade-in slide-in-from-bottom-1 duration-200">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent text-white px-4 py-2.5 text-sm leading-relaxed" dir="auto">
                  {msg.content}
                </div>
              </div>
            );
          }

          return (
            <div key={i} className="group/msg animate-in fade-in duration-300">
              <div className="flex gap-3 items-start">
                <div className="shrink-0 flex flex-col items-center gap-1.5">
                  <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-accent/20 to-accent/5">
                    <Sparkles size={14} className="text-accent" />
                  </div>
                  {isActiveStream && msg.content === "" && (
                    <div className="flex gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent/50 animate-bounce [animation-delay:0ms]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-accent/50 animate-bounce [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-accent/50 animate-bounce [animation-delay:300ms]" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0 text-sm leading-relaxed text-text-primary" dir="auto">
                  {renderContent(msg.content)}
                  {isActiveStream && msg.content !== "" && (
                    <span className="inline-block w-1.5 h-4 bg-accent/60 animate-pulse ml-0.5 -mb-0.5 rounded-sm" />
                  )}
                </div>
              </div>
              {/* Action bar — copy + regenerate */}
              {msg.content && !isActiveStream && (
                <div className="flex gap-0.5 mt-1 mr-10 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-200">
                  <button
                    onClick={() => copyMessage(msg.content, i)}
                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-text-muted hover:bg-bg-secondary hover:text-text-primary transition-colors"
                    title="نسخ"
                  >
                    {copiedIdx === i ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                  </button>
                  {isLast && (
                    <button
                      onClick={regenerateLastResponse}
                      className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-text-muted hover:bg-bg-secondary hover:text-text-primary transition-colors"
                      title="إعادة التوليد"
                    >
                      <RefreshCw size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input composer */}
      <div className="shrink-0 px-3 pb-3 pt-2">
        <div className="relative flex items-end rounded-2xl border border-border/60 bg-bg-elevated shadow-sm focus-within:border-accent/40 focus-within:shadow-md transition-all">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="اكتب رسالة..."
            dir="auto"
            rows={1}
            className="flex-1 resize-none bg-transparent py-3 pr-4 pl-12 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none font-arabic"
            style={{ maxHeight: 160 }}
            onInput={(e) => {
              const t = e.currentTarget;
              t.style.height = "auto";
              t.style.height = Math.min(t.scrollHeight, 160) + "px";
            }}
          />
          <div className="absolute bottom-1.5 left-1.5">
            {streaming ? (
              <button
                onClick={stopGeneration}
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-text-primary text-white hover:bg-text-primary/80 active:scale-95 transition-all"
                title="إيقاف التوليد"
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim()}
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-text-primary text-white disabled:opacity-20 disabled:cursor-default hover:bg-text-primary/80 active:scale-95 transition-all"
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
        {messages.length > 0 && (
          <div className="flex items-center justify-center gap-2 mt-1.5 text-[10px] text-text-muted/60">
            <span>~{(sessionTokens.input + sessionTokens.output).toLocaleString()} tokens</span>
            <span>·</span>
            <span>{formatCost(sessionTokens.input, sessionTokens.output)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
