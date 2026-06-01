"use client";

import {
  useRef,
  useEffect,
  forwardRef,
  type KeyboardEvent,
} from "react";
import { ArrowUp, Square } from "lucide-react";

interface ChatComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
}

const ChatComposer = forwardRef<HTMLTextAreaElement, ChatComposerProps>(
  function ChatComposer(
    { value, onChange, onSend, onStop, streaming, disabled },
    ref,
  ) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Expose the internal textarea node through the forwarded ref.
    const setRefs = (el: HTMLTextAreaElement | null) => {
      textareaRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    };

    // Auto-grow the textarea up to a max height.
    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }, [value]);

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!streaming && value.trim()) onSend();
      }
    };

    const canSend = value.trim().length > 0 && !disabled;

    return (
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        <div className="flex items-end gap-2 rounded-3xl border border-border bg-bg-elevated p-2 shadow-md focus-within:border-accent/50 focus-within:shadow-lg transition-all">
          <textarea
            ref={setRefs}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            dir="rtl"
            placeholder="اسأل عن أي موضوع في مجموعة المقالات…"
            className="max-h-[200px] flex-1 resize-none bg-transparent px-3 py-2 font-arabic text-[14.5px] leading-relaxed text-text-primary outline-none placeholder:text-text-muted"
          />
          {streaming ? (
            <button
              onClick={onStop}
              aria-label="إيقاف"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-text-primary text-white transition hover:opacity-80"
            >
              <Square size={15} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!canSend}
              aria-label="إرسال"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white transition enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[10.5px] text-text-muted font-arabic">
          اضغط Enter للإرسال · Shift+Enter لسطر جديد
        </p>
      </div>
    );
  },
);

export default ChatComposer;
