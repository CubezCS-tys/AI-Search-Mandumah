"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

// ── Arabic keyboard layout (standard) ────────────────────────────────

const ROWS_NORMAL: string[][] = [
  ["ذ", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩", "٠", "-", "="],
  ["ض", "ص", "ث", "ق", "ف", "غ", "ع", "ه", "خ", "ح", "ج", "د"],
  ["ش", "س", "ي", "ب", "ل", "ا", "ت", "ن", "م", "ك", "ط"],
  ["ئ", "ء", "ؤ", "ر", "لا", "ى", "ة", "و", "ز", "ظ"],
];

const ROWS_SHIFT: string[][] = [
  ["ّ", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+"],
  ["َ", "ً", "ُ", "ٌ", "لإ", "إ", "'", "÷", "×", "؛", "<", ">"],
  ["ِ", "ٍ", "]", "[", "لأ", "أ", "ـ", "،", "/", ":"],
  ["~", "ْ", "}", "{", "لآ", "آ", "'", ",", ".", "؟"],
];

interface ArabicKeyboardProps {
  onKeyPress: (char: string) => void;
  onBackspace: () => void;
  onSpace: () => void;
  visible: boolean;
  onToggle: () => void;
}

export default function ArabicKeyboard({
  onKeyPress,
  onBackspace,
  onSpace,
  visible,
  onToggle,
}: ArabicKeyboardProps) {
  const [shifted, setShifted] = useState(false);
  const rows = shifted ? ROWS_SHIFT : ROWS_NORMAL;
  const keyboardRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!visible) return;
    const handler = (e: MouseEvent) => {
      if (
        keyboardRef.current &&
        !keyboardRef.current.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest("[data-keyboard-toggle]")
      ) {
        onToggle();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [visible, onToggle]);

  const handleKey = useCallback(
    (char: string) => {
      onKeyPress(char);
      if (shifted) setShifted(false);
    },
    [onKeyPress, shifted],
  );

  return (
    <>
      {/* Toggle button */}
      <button
        data-keyboard-toggle
        type="button"
        onClick={onToggle}
        className={`
          relative flex-shrink-0 p-2 rounded-lg transition-all duration-200
          ${visible
            ? "bg-accent/10 text-accent border border-accent/25"
            : "text-text-muted/60 hover:text-text-secondary hover:bg-bg-primary border border-transparent"
          }
        `}
        title="لوحة مفاتيح عربية"
      >
        {/* Subtle glow when active */}
        {visible && (
          <div
            className="absolute inset-0 rounded-lg blur-sm opacity-30 pointer-events-none"
            style={{ background: "var(--accent)" }}
          />
        )}
        <svg
          className="relative w-5 h-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="2" y="4" width="20" height="16" rx="3" />
          <line x1="6" y1="8" x2="6.01" y2="8" strokeWidth="2" strokeLinecap="round" />
          <line x1="10" y1="8" x2="10.01" y2="8" strokeWidth="2" strokeLinecap="round" />
          <line x1="14" y1="8" x2="14.01" y2="8" strokeWidth="2" strokeLinecap="round" />
          <line x1="18" y1="8" x2="18.01" y2="8" strokeWidth="2" strokeLinecap="round" />
          <line x1="6" y1="12" x2="6.01" y2="12" strokeWidth="2" strokeLinecap="round" />
          <line x1="10" y1="12" x2="10.01" y2="12" strokeWidth="2" strokeLinecap="round" />
          <line x1="14" y1="12" x2="14.01" y2="12" strokeWidth="2" strokeLinecap="round" />
          <line x1="18" y1="12" x2="18.01" y2="12" strokeWidth="2" strokeLinecap="round" />
          <line x1="8" y1="16" x2="16" y2="16" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      {/* Keyboard */}
      <AnimatePresence>
        {visible && (
          <motion.div
            ref={keyboardRef}
            initial={{ opacity: 0, y: -10, scale: 0.97 }}
            animate={{
              opacity: 1,
              y: 0,
              scale: 1,
            }}
            exit={{ opacity: 0, y: -10, scale: 0.97 }}
            transition={{ type: "spring", damping: 28, stiffness: 350 }}
            className="absolute left-1/2 -translate-x-1/2 z-50 select-none"
            style={{ top: "calc(100% + 12px)", width: "min(95vw, 640px)" }}
          >
            {/* Outer halo — soft radial glow */}
            <div
              className="absolute -inset-6 rounded-[28px] pointer-events-none"
              style={{
                background:
                  "radial-gradient(ellipse at center, rgba(155,27,48,0.06), rgba(155,27,48,0.02), transparent 70%)",
                filter: "blur(20px)",
              }}
            />

            {/* Animated accent ring */}
            <div
              className="absolute -inset-[1.5px] rounded-[18px] pointer-events-none"
              style={{
                background:
                  "linear-gradient(135deg, rgba(155,27,48,0.2), rgba(155,27,48,0.05), rgba(155,27,48,0.12), rgba(155,27,48,0.2))",
                backgroundSize: "300% 300%",
                animation: "keyboard-halo 5s ease infinite",
              }}
            />

            {/* Main keyboard body */}
            <div
              className="relative rounded-2xl p-2.5"
              style={{
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.97) 0%, rgba(248,248,250,0.98) 100%)",
                backdropFilter: "blur(24px)",
                WebkitBackdropFilter: "blur(24px)",
                boxShadow: `
                  0 0 0 1px rgba(155,27,48,0.06),
                  0 0 30px rgba(155,27,48,0.04),
                  0 8px 32px rgba(0,0,0,0.08),
                  0 2px 8px rgba(0,0,0,0.04),
                  inset 0 1px 0 rgba(255,255,255,0.9)
                `,
              }}
            >
              {/* Rows */}
              {rows.map((row, rowIdx) => (
                <div
                  key={rowIdx}
                  className="flex justify-center gap-[3px] mb-[3px]"
                  style={{
                    paddingRight: `${rowIdx * 6}px`,
                    paddingLeft: `${rowIdx * 6}px`,
                  }}
                >
                  {row.map((char, charIdx) => (
                    <Key key={`${rowIdx}-${charIdx}`} char={char} onClick={() => handleKey(char)} />
                  ))}

                  {/* Backspace on first row */}
                  {rowIdx === 0 && (
                    <SpecialKey label="⌫" onClick={onBackspace} width="w-12" />
                  )}
                </div>
              ))}

              {/* Bottom row */}
              <div className="flex justify-center gap-[3px] mt-[3px]">
                <SpecialKey
                  label={shifted ? "⇧" : "⇪"}
                  onClick={() => setShifted(!shifted)}
                  width="w-14"
                  active={shifted}
                />
                <button
                  type="button"
                  onClick={onSpace}
                  className="relative h-9 rounded-lg flex-1 max-w-[280px] group transition-all duration-150"
                  style={{
                    background: "linear-gradient(180deg, #f8f8fa 0%, #f0f0f3 100%)",
                    border: "1px solid rgba(0,0,0,0.08)",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                  }}
                >
                  <div
                    className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                    style={{
                      background: "linear-gradient(180deg, rgba(155,27,48,0.04) 0%, rgba(155,27,48,0.01) 100%)",
                    }}
                  />
                  <span className="relative text-text-muted/40 text-xs font-arabic">مسافة</span>
                </button>
                <SpecialKey label="↵" onClick={() => onKeyPress("\n")} width="w-14" />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <style jsx global>{`
        @keyframes keyboard-halo {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
      `}</style>
    </>
  );
}

// ── Key components ──────────────────────────────────────────────────────

function Key({ char, onClick }: { char: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative h-9 w-9 rounded-lg flex items-center justify-center group transition-all duration-100 active:scale-[0.94]"
      style={{
        background: "linear-gradient(180deg, #ffffff 0%, #f6f6f8 100%)",
        border: "1px solid rgba(0,0,0,0.08)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 0.5px 1px rgba(0,0,0,0.03)",
      }}
    >
      {/* Hover glow */}
      <div
        className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none"
        style={{
          background: "linear-gradient(180deg, rgba(155,27,48,0.06) 0%, rgba(155,27,48,0.02) 100%)",
          boxShadow: "0 0 8px rgba(155,27,48,0.06), inset 0 1px 0 rgba(255,255,255,0.8)",
        }}
      />
      {/* Active press */}
      <div
        className="absolute inset-0 rounded-lg opacity-0 group-active:opacity-100 transition-opacity duration-75 pointer-events-none"
        style={{
          background: "linear-gradient(180deg, rgba(155,27,48,0.1) 0%, rgba(155,27,48,0.04) 100%)",
          boxShadow: "0 0 12px rgba(155,27,48,0.08)",
        }}
      />
      <span className="relative text-text-primary/80 text-sm font-arabic group-hover:text-accent transition-colors">
        {char}
      </span>
    </button>
  );
}

function SpecialKey({
  label,
  onClick,
  width,
  active,
}: {
  label: string;
  onClick: () => void;
  width: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative h-9 ${width} rounded-lg flex items-center justify-center group transition-all duration-100 active:scale-[0.94]`}
      style={{
        background: active
          ? "linear-gradient(180deg, rgba(155,27,48,0.08) 0%, rgba(155,27,48,0.04) 100%)"
          : "linear-gradient(180deg, #f4f4f6 0%, #eeeef0 100%)",
        border: active
          ? "1px solid rgba(155,27,48,0.2)"
          : "1px solid rgba(0,0,0,0.06)",
        boxShadow: active
          ? "0 0 10px rgba(155,27,48,0.06)"
          : "0 1px 2px rgba(0,0,0,0.03)",
      }}
    >
      <div
        className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none"
        style={{
          background: "linear-gradient(180deg, rgba(155,27,48,0.05) 0%, rgba(155,27,48,0.02) 100%)",
        }}
      />
      <span className={`relative text-sm transition-colors ${active ? "text-accent" : "text-text-muted group-hover:text-text-secondary"}`}>
        {label}
      </span>
    </button>
  );
}
