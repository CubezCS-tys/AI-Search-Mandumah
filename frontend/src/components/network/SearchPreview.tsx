"use client";

import { useRef, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { RefObject } from "react";
import type { NetworkHandle } from "./NetworkBackground";
import type { SearchResultItem } from "@/types/search";

/* ── Types ──────────────────────────────────────────────────── */

interface Props {
  results: SearchResultItem[];
  networkRef: RefObject<NetworkHandle | null>;
  active: boolean;
}

/* ── Config ─────────────────────────────────────────────────── */

const CARD_W = 230;
const CARD_GAP = 12;

/* ── Helpers ────────────────────────────────────────────────── */

function getCardPositions(count: number, vw: number, vh: number) {
  const positions: { x: number; y: number }[] = [];
  const totalH = count * 72 + (count - 1) * CARD_GAP;
  const startY = (vh - totalH) / 2;
  const x = vw - CARD_W - 32;
  for (let i = 0; i < count; i++) {
    positions.push({ x, y: startY + i * (72 + CARD_GAP) });
  }
  return positions;
}

function truncate(text: string, maxLen: number) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

/* ── Component ──────────────────────────────────────────────── */

export default function SearchPreview({ results, networkRef, active }: Props) {
  const lineCanvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const [vpSize, setVpSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    setVpSize({ w: window.innerWidth, h: window.innerHeight });
  }, []);

  const cardPositions = useMemo(
    () => vpSize ? getCardPositions(results.length, vpSize.w, vpSize.h) : [],
    [results.length, vpSize]
  );

  /* ── Connecting lines via canvas rAF ─────────────────────── */

  useEffect(() => {
    if (!active || results.length === 0) return;
    const canvas = lineCanvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    canvas.width = vw * dpr;
    canvas.height = vh * dpr;
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    function drawLines() {
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas!.width, canvas!.height);

      const nodePosArray = networkRef.current?.getResultPositions() ?? [];
      if (nodePosArray.length === 0) {
        rafRef.current = requestAnimationFrame(drawLines);
        return;
      }

      for (let i = 0; i < Math.min(results.length, nodePosArray.length, cardPositions.length); i++) {
        const np = nodePosArray[i];
        const cp = cardPositions[i];
        if (!np || !cp) continue;

        const sx = np.x * dpr;
        const sy = np.y * dpr;
        const ex = cp.x * dpr;
        const ey = (cp.y + 36) * dpr;

        const cpx1 = sx + (ex - sx) * 0.5;
        const cpy1 = sy;
        const cpx2 = sx + (ex - sx) * 0.5;
        const cpy2 = ey;

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(cpx1, cpy1, cpx2, cpy2, ex, ey);
        ctx.strokeStyle = "rgba(155,27,48,0.18)";
        ctx.lineWidth = 1.2 * dpr;
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Glow duplicate
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(cpx1, cpy1, cpx2, cpy2, ex, ey);
        ctx.strokeStyle = "rgba(220,60,90,0.07)";
        ctx.lineWidth = 4 * dpr;
        ctx.stroke();
      }

      rafRef.current = requestAnimationFrame(drawLines);
    }

    rafRef.current = requestAnimationFrame(drawLines);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, results.length, networkRef, cardPositions]);

  if (!active || results.length === 0) return null;

  return (
    <>
      <canvas
        ref={lineCanvasRef}
        className="fixed inset-0 pointer-events-none"
        style={{ zIndex: 21 }}
        aria-hidden="true"
      />
      <AnimatePresence>
        {results.map((r, i) => {
          const pos = cardPositions[i];
          if (!pos) return null;
          return (
            <motion.div
              key={r.chunk_id}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 40 }}
              transition={{ delay: 0.8 + i * 0.3, duration: 0.45, ease: "easeOut" }}
              className="fixed pointer-events-none"
              style={{
                zIndex: 22,
                top: pos.y,
                left: pos.x,
                width: CARD_W,
              }}
            >
              <div
                className="rounded-xl px-3.5 py-2.5 border"
                style={{
                  background: "rgba(var(--bg-elevated-rgb), 0.82)",
                  backdropFilter: "blur(14px)",
                  WebkitBackdropFilter: "blur(14px)",
                  borderColor: "rgba(155,27,48,0.16)",
                  boxShadow: "0 2px 16px rgba(155,27,48,0.08)",
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="text-[10px] font-bold rounded-full px-1.5 py-0.5 text-white"
                    style={{ background: "rgba(155,27,48,0.85)" }}
                  >
                    #{i + 1}
                  </span>
                  <span className="text-[10px] text-gray-400 font-mono">
                    {r.score.toFixed(4)}
                  </span>
                </div>
                <p
                  className="text-[12px] font-bold text-gray-800 leading-tight"
                  dir="rtl"
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 1,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {r.title}
                </p>
                <p
                  className="text-[10px] text-gray-500 mt-0.5 leading-snug"
                  dir="rtl"
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {truncate(r.text, 100)}
                </p>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </>
  );
}
