"use client";

import { use, Suspense, useState, useRef, useCallback, useEffect, Component, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Header from "@/components/layout/Header";
import DocumentViewer from "@/components/document/DocumentViewer";
import ChatPanel from "@/components/document/ChatPanel";

/* ── Error boundary ──────────────────────────────────────── */

class DocumentErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-svh flex items-center justify-center bg-bg-primary" dir="rtl">
          <div className="text-center space-y-3 max-w-md px-6">
            <p className="text-lg font-bold text-red-600 font-arabic">حدث خطأ غير متوقع</p>
            <p className="text-sm text-text-muted font-arabic">{this.state.error?.message}</p>
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover transition-colors font-arabic"
            >
              إعادة تحميل الصفحة
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function DocumentContent({ docId }: { docId: string }) {
  const searchParams = useSearchParams();
  const query = searchParams.get("q") || "";
  const citeParam = searchParams.get("cite") || "";
  const [chatOpen, setChatOpen] = useState(false);
  const [ripple, setRipple] = useState<{ x: number; y: number } | null>(null);
  // Seed from a deep-linked citation (e.g. a corpus-chat «quote») so the viewer
  // highlights the passage as soon as the document's OCR loads.
  const [citationText, setCitationText] = useState<string | null>(citeParam || null);
  const [citationKey, setCitationKey] = useState(0);
  const [citationNotFound, setCitationNotFound] = useState(false);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const rippleTimeout = useRef<ReturnType<typeof setTimeout>>(null);
  const citationTimeout = useRef<ReturnType<typeof setTimeout>>(null);

  const openChat = useCallback((e: React.MouseEvent) => {
    // Start ripple from button center
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setRipple({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

    // After ripple expands, open the split
    rippleTimeout.current = setTimeout(() => {
      setChatOpen(true);
      // Fade out ripple
      setTimeout(() => setRipple(null), 400);
    }, 350);
  }, []);

  const handleCitationClick = useCallback((text: string) => {
    setCitationText(text);
    setCitationKey((k) => k + 1);
    setCitationNotFound(false);
    // Auto-clear after 15 seconds
    if (citationTimeout.current) clearTimeout(citationTimeout.current);
    citationTimeout.current = setTimeout(() => setCitationText(null), 15000);
  }, []);

  const handleCitationNotFound = useCallback(() => {
    setCitationNotFound(true);
    setCitationText(null);
    setTimeout(() => setCitationNotFound(false), 3000);
  }, []);

  const handleAskAboutSelection = useCallback((text: string) => {
    setSelectedText(text);
    if (!chatOpen) {
      setChatOpen(true);
    }
  }, [chatOpen]);

  const closeChat = useCallback(() => {
    setChatOpen(false);
  }, []);

  // Escape key to close chat
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && chatOpen) {
        setChatOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [chatOpen]);

  return (
    <div className="min-h-svh bg-bg-primary">
      <Header compact />

      {/* Ripple overlay — multiple expanding rings */}
      {ripple && (
        <div
          className="fixed inset-0 z-[200] pointer-events-none"
          style={{ overflow: "hidden" }}
        >
          {/* Primary ring — fast, bold */}
          <div
            className="absolute rounded-full"
            style={{
              left: ripple.x,
              top: ripple.y,
              width: 0,
              height: 0,
              transform: "translate(-50%, -50%)",
              background: "radial-gradient(circle, rgba(155,27,48,0.18) 0%, rgba(155,27,48,0.06) 50%, transparent 100%)",
              animation: "chat-ripple-1 0.65s cubic-bezier(0.22, 1, 0.36, 1) forwards",
            }}
          />
          {/* Secondary ring — delayed, softer */}
          <div
            className="absolute rounded-full"
            style={{
              left: ripple.x,
              top: ripple.y,
              width: 0,
              height: 0,
              transform: "translate(-50%, -50%)",
              border: "2px solid rgba(155,27,48,0.15)",
              animation: "chat-ripple-2 0.8s cubic-bezier(0.22, 1, 0.36, 1) 0.08s forwards",
            }}
          />
          {/* Tertiary ring — slowest, blurred glow */}
          <div
            className="absolute rounded-full"
            style={{
              left: ripple.x,
              top: ripple.y,
              width: 0,
              height: 0,
              transform: "translate(-50%, -50%)",
              background: "radial-gradient(circle, rgba(155,27,48,0.08) 0%, transparent 70%)",
              filter: "blur(40px)",
              animation: "chat-ripple-3 1s cubic-bezier(0.22, 1, 0.36, 1) 0.05s forwards",
            }}
          />
        </div>
      )}

      {/* PDF takes full width but leaves room when chat is open (desktop split;
          on mobile the chat panel overlays full-width instead of pushing). */}
      <div
        className={`transition-all duration-500 ease-out ${
          chatOpen ? "lg:mr-[45%]" : "mr-0"
        }`}
      >
        <DocumentViewer docId={docId} query={query} chatOpen={chatOpen} citationText={citationText} citationKey={citationKey} onCitationNotFound={handleCitationNotFound} onAskAboutSelection={handleAskAboutSelection} analyzing={analyzing} />
      </div>

      {/* Chat panel — full-width drawer on mobile, 45% side split on desktop */}
      {chatOpen && (
      <div
        className="fixed top-13 right-0 bottom-0 z-50 w-full border-l border-border/60 bg-bg-elevated shadow-[-8px_0_30px_rgba(0,0,0,0.08)] lg:w-[45%]"
        style={{
          animation: "chat-slide-in 0.45s cubic-bezier(0.16, 1, 0.3, 1) both",
        }}
      >
        <ChatPanel docId={docId} onClose={closeChat} onCitationClick={handleCitationClick} selectedText={selectedText} onSelectedTextConsumed={() => setSelectedText(null)} onAnalyzingChange={setAnalyzing} embedded />
      </div>
      )}

      {/* Citation not found toast */}
      {citationNotFound && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[300] animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="rounded-xl bg-gray-900 text-white px-4 py-2.5 text-sm shadow-xl font-arabic flex items-center gap-2">
            <span className="text-amber-400">⚠</span>
            <span>لم يتم العثور على هذا الاقتباس في المستند</span>
          </div>
        </div>
      )}

      {/* Floating chat toggle (only when chat is closed) */}
      {!chatOpen && (
        <div className="fixed bottom-6 right-6 z-50">
          {/* Outer pulse rings */}
          <span
            className="absolute inset-0 rounded-full bg-accent/20"
            style={{ animation: "chat-btn-pulse 2.5s ease-out infinite" }}
          />
          <span
            className="absolute inset-0 rounded-full bg-accent/10"
            style={{ animation: "chat-btn-pulse 2.5s ease-out 0.8s infinite" }}
          />
          <button
            onClick={openChat}
            className="relative flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-xl hover:bg-accent-hover hover:scale-110 active:scale-90 transition-all duration-200"
            title="محادثة مع المستند"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
            </svg>
          </button>
        </div>
      )}

      {/* Ripple + button keyframes */}
      <style jsx global>{`
        @keyframes chat-ripple-1 {
          0% { width: 0; height: 0; opacity: 1; }
          60% { opacity: 0.6; }
          100% { width: 300vmax; height: 300vmax; opacity: 0; }
        }
        @keyframes chat-ripple-2 {
          0% { width: 0; height: 0; opacity: 1; }
          50% { opacity: 0.5; }
          100% { width: 280vmax; height: 280vmax; opacity: 0; }
        }
        @keyframes chat-ripple-3 {
          0% { width: 0; height: 0; opacity: 1; }
          40% { opacity: 0.8; }
          100% { width: 320vmax; height: 320vmax; opacity: 0; }
        }
        @keyframes chat-btn-pulse {
          0% { transform: scale(1); opacity: 0.5; }
          100% { transform: scale(2.2); opacity: 0; }
        }
        @keyframes chat-slide-in {
          0% { transform: translateX(100%); opacity: 0.5; }
          100% { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

export default function DocumentPage({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
  const { docId } = use(params);

  return (
    <Suspense>
      <DocumentErrorBoundary>
        <DocumentContent docId={docId} />
      </DocumentErrorBoundary>
    </Suspense>
  );
}
