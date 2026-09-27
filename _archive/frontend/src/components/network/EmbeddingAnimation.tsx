"use client";

import { useRef, useEffect, useCallback } from "react";

/* ── Types ─────────────────────────────────────────────────── */

interface WordParticle {
  word: string;
  // center of word in layout
  sx: number;
  sy: number;
  // total rendered width
  width: number;
  // word-level stagger 0–1
  stagger: number;
}

interface ColumnCell {
  value: string;
  tx: number;
  ty: number;
  dimensionIdx: number;
  sourceX: number;
  sourceY: number;
  arrivalT: number;
}

interface Props {
  query: string;
  onEmbeddingDone: () => void;
  onComplete: () => void;
}

/* ── Config ─────────────────────────────────────────────────── */

const ACCENT_R = 155, ACCENT_G = 27, ACCENT_B = 48;
const GLOW_R = 220, GLOW_G = 60, GLOW_B = 90;

// Phase durations (seconds)
const P_SHOW     = 0.55;  // text fades in
const P_MORPH    = 1.1;   // words dissolve
const P_STREAM   = 1.5;   // numbers stream from words → vector column
const P_SETTLE   = 0.6;   // vector visible, labels shown
const P_COLLAPSE = 0.7;   // vector converges to center
const P_BURST    = 0.35;  // burst ring
const TOTAL = P_SHOW + P_MORPH + P_STREAM + P_SETTLE + P_COLLAPSE + P_BURST;

// Vector block layout
const VECTOR_ROWS = 14;
const COL_W = 78;
const ROW_H  = 18;
const NUM_COLS = 4;

/* ── Helpers ────────────────────────────────────────────────── */

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function clamp01(t: number) { return Math.max(0, Math.min(1, t)); }
function easeOut(t: number) { return 1 - (1 - t) ** 3; }
function easeIn(t: number)  { return t ** 3; }
function easeInOut(t: number) {
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}

function seededRand(seed: number) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function fakeVector(seed: number): string {
  const v = (seededRand(seed) - 0.5) * 0.22;
  return (v >= 0 ? " " : "") + v.toFixed(4);
}

/* ── Component ──────────────────────────────────────────────── */

export default function EmbeddingAnimation({ query, onEmbeddingDone, onComplete }: Props) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const animRef    = useRef(0);
  const t0Ref      = useRef<number | null>(null);
  const wordsRef   = useRef<WordParticle[]>([]);
  const cellsRef   = useRef<ColumnCell[]>([]);
  const firedRef   = useRef(false);
  const doneRef    = useRef(false);
  const dprRef     = useRef(1);
  const sizeRef    = useRef({ w: 0, h: 0 });

  /* ── Initialize ───────────────────────────────────────────── */

  const init = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr  = dprRef.current;
    const w    = sizeRef.current.w;
    const h    = sizeRef.current.h;
    const cx   = w / 2;
    const cy   = h / 2;

    // Measure whole words — no per-character positioning (Arabic is ligated)
    const ctx = canvas.getContext("2d")!;
    const rawWords = query.split(/\s+/).filter(Boolean);
    const fontSize = Math.min(32, w * 0.038);
    ctx.font = `700 ${fontSize * dpr}px Tajawal, system-ui, sans-serif`;

    const wordGap = 16;
    const wordMetrics = rawWords.map(wrd => ({
      wrd,
      width: ctx.measureText(wrd).width / dpr,
    }));
    const totalW = wordMetrics.reduce((s, m) => s + m.width, 0) + wordGap * (wordMetrics.length - 1);
    // RTL: lay out from right edge toward left
    let cursorX = cx + totalW / 2;

    const words: WordParticle[] = wordMetrics.map((wm, wi) => {
      cursorX -= wm.width;
      const wordLeft = cursorX;
      cursorX -= wordGap;
      return {
        word: wm.wrd,
        sx: wordLeft + wm.width / 2,
        sy: cy,
        width: wm.width,
        stagger: wi / Math.max(1, rawWords.length - 1),
      };
    });

    // Build column cells — stream from word positions to grid
    const totalCells = VECTOR_ROWS * NUM_COLS;
    const colGridW = NUM_COLS * COL_W;
    const colGridH = VECTOR_ROWS * ROW_H;
    const gridLeft = cx - colGridW / 2;
    const gridTop  = cy - colGridH / 2;

    // Flatten word centers as source positions for cells
    const allGlyphs: { x: number; y: number; seed: number }[] = [];
    words.forEach((wp, wi) => {
      const slots = Math.max(2, Math.round(wp.width / 20));
      for (let s = 0; s < slots; s++) {
        const fx = wp.sx - wp.width / 2 + (s + 0.5) * (wp.width / slots);
        allGlyphs.push({ x: fx, y: wp.sy, seed: wi * 200 + s * 7 });
      }
    });

    const cells: ColumnCell[] = [];
    for (let row = 0; row < VECTOR_ROWS; row++) {
      for (let col = 0; col < NUM_COLS; col++) {
        const idx = row * NUM_COLS + col;
        const src = allGlyphs[idx % allGlyphs.length];
        const arrivalT = (col * VECTOR_ROWS + row) / totalCells;
        cells.push({
          value: fakeVector(idx * 3 + 1),
          tx: gridLeft + col * COL_W + COL_W / 2,
          ty: gridTop + row * ROW_H,
          dimensionIdx: idx + 1,
          sourceX: src.x,
          sourceY: src.y,
          arrivalT,
        });
      }
    }

    wordsRef.current = words;
    cellsRef.current = cells;
    firedRef.current = false;
    doneRef.current  = false;
  }, [query]);

  /* ── Draw ─────────────────────────────────────────────────── */

  const draw = useCallback((now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (t0Ref.current === null) t0Ref.current = now;
    const t = (now - t0Ref.current) / 1000;

    const dpr = dprRef.current;
    const w   = sizeRef.current.w;
    const h   = sizeRef.current.h;
    const cx  = w / 2;
    const cy  = h / 2;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Phase time boundaries
    const tMorph    = P_SHOW;
    const tStream   = tMorph + P_MORPH;
    const tSettle   = tStream + P_STREAM;
    const tCollapse = tSettle + P_SETTLE;
    const tBurst    = tCollapse + P_COLLAPSE;

    const words = wordsRef.current;
    const cells = cellsRef.current;
    const totalCells = VECTOR_ROWS * NUM_COLS;
    const colGridW = NUM_COLS * COL_W;
    const colGridH = VECTOR_ROWS * ROW_H;
    const gridLeft = cx - colGridW / 2;
    const gridTop  = cy - colGridH / 2;
    const fontSize = Math.min(32, w * 0.038);

    // ── Phase 1: Show + Morph — whole words fade in, then dissolve ──

    if (t < tStream) {
      for (let wi = 0; wi < words.length; wi++) {
        const wp = words[wi];
        const appearT = clamp01((t - wp.stagger * 0.12) * (1 / P_SHOW));
        if (appearT <= 0) continue;
        const morphStart = tMorph + wp.stagger * P_MORPH * 0.3;
        const morphT     = clamp01((t - morphStart) / (P_MORPH * 0.6));
        const wordAlpha  = appearT * (1 - easeIn(morphT));
        if (wordAlpha > 0.01) {
          ctx.save();
          ctx.globalAlpha  = wordAlpha;
          ctx.font         = `700 ${fontSize * dpr}px Tajawal, system-ui, sans-serif`;
          ctx.textAlign    = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle    = `rgb(${ACCENT_R},${ACCENT_G},${ACCENT_B})`;
          ctx.shadowBlur   = 0;
          ctx.fillText(wp.word, wp.sx * dpr, wp.sy * dpr);
          ctx.restore();
        }
      }
    }

    // ── Phase 2: Stream — numbers fly from word positions → column ──

    if (t > tMorph && t < tCollapse + 0.15) {
      for (const cell of cells) {
        const streamStart = tStream + cell.arrivalT * P_STREAM * 0.85;
        const streamDur   = P_STREAM * 0.28;

        let cx2: number, cy2: number, ca: number, cScale: number;

        if (t < tStream) {
          continue;
        } else if (t < streamStart) {
          // Waiting to stream: fade in at source
          const waitAge = t - tStream;
          const fadeIn  = clamp01(waitAge * 4 - cell.arrivalT * 2);
          cx2 = cell.sourceX;
          cy2 = cell.sourceY;
          ca = fadeIn * 0.45;
          cScale = 0.75;
        } else if (t < streamStart + streamDur) {
          // Streaming: arc toward column
          const sT = easeInOut(clamp01((t - streamStart) / streamDur));
          const midX = lerp(cell.sourceX, cell.tx, 0.5);
          const midY = lerp(cell.sourceY, cell.ty, 0.5) - 30 * Math.sin(Math.PI * sT);
          const bx = lerp(lerp(cell.sourceX, midX, sT), lerp(midX, cell.tx, sT), sT);
          const by = lerp(lerp(cell.sourceY, midY, sT), lerp(midY, cell.ty, sT), sT);
          cx2 = bx;
          cy2 = by;
          ca = lerp(0.45, 0.95, sT);
          cScale = lerp(0.75, 0.9, sT);
        } else if (t < tSettle) {
          cx2 = cell.tx;
          cy2 = cell.ty;
          ca = 0.95;
          cScale = 0.9;
        } else if (t < tCollapse) {
          cx2 = cell.tx;
          cy2 = cell.ty;
          ca = 0.85;
          cScale = 0.88;
        } else if (t < tBurst) {
          const colT = easeIn(clamp01((t - tCollapse - cell.arrivalT * 0.08) / (P_COLLAPSE * 0.9)));
          cx2 = lerp(cell.tx, cx, colT);
          cy2 = lerp(cell.ty, cy, colT);
          ca  = lerp(0.85, 0, colT);
          cScale = lerp(0.88, 0.2, colT);
        } else {
          continue;
        }

        if (ca < 0.005) continue;

        ctx.save();
        ctx.translate(cx2 * dpr, cy2 * dpr);
        ctx.globalAlpha  = ca;
        ctx.shadowBlur   = 0;
        ctx.font         = `500 ${10 * cScale * dpr}px 'SF Mono', 'Fira Code', monospace`;
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle    = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},1)`;
        ctx.fillText(cell.value, 0, 0);
        ctx.restore();
      }
    }

    // ── Vector column decorations (brackets + labels) ────────

    if (t > tStream - 0.1 && t < tBurst) {
      const formProgress = clamp01((t - tStream) / P_STREAM);
      const settleAlpha  = clamp01((t - tStream + 0.1) * 1.8) * clamp01(1 - (t - tCollapse) * 4);

      // Brackets
      const bracketA = settleAlpha * 0.3;
      if (bracketA > 0.01) {
        const bx1 = (gridLeft - 14) * dpr;
        const bx2 = (gridLeft + colGridW + 14) * dpr;
        const by1 = (gridTop - 8) * dpr;
        const by2 = (gridTop + colGridH * Math.min(1, formProgress * 1.3) + 8) * dpr;
        const bw  = 7 * dpr;
        ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${bracketA})`;
        ctx.lineWidth   = 1.5 * dpr;
        ctx.lineCap     = "round";
        ctx.beginPath(); ctx.moveTo(bx1 + bw, by1); ctx.lineTo(bx1, by1);
        ctx.lineTo(bx1, by2); ctx.lineTo(bx1 + bw, by2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx2 - bw, by1); ctx.lineTo(bx2, by1);
        ctx.lineTo(bx2, by2); ctx.lineTo(bx2 - bw, by2); ctx.stroke();
      }

      // float[NNNN] counter + sparse label
      if (t > tStream + P_STREAM * 0.3 && t < tCollapse + 0.1) {
        const la = clamp01((t - tStream - P_STREAM * 0.3) * 2.5) * clamp01(1 - (t - tCollapse) * 5) * 0.75;
        if (la > 0) {
          const dimFilled = Math.min(1024, Math.floor(formProgress * 1024));
          ctx.font = `600 ${12 * dpr}px 'SF Mono', 'Fira Code', monospace`;
          ctx.textAlign = "center";
          ctx.fillStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${la})`;
          ctx.fillText(`float[${dimFilled.toString().padStart(4, "0")}]`, cx * dpr, (gridTop - 22) * dpr);

          ctx.font = `400 ${10 * dpr}px Tajawal, system-ui`;
          ctx.fillStyle = `rgba(${ACCENT_R},${ACCENT_G},${ACCENT_B},${la * 0.6})`;
          ctx.fillText("+ sparse vector", cx * dpr, (gridTop + colGridH + 24) * dpr);
        }
      }

      // Scan line sweeping down during stream
      if (t > tStream && t < tSettle + 0.2) {
        const scanT = clamp01((t - tStream) / P_STREAM);
        const scanY = (gridTop + scanT * colGridH) * dpr;
        const scanA = (1 - Math.abs(scanT - 0.5) * 2) * 0.3;
        if (scanA > 0) {
          const scanGrad = ctx.createLinearGradient(gridLeft * dpr, scanY, (gridLeft + colGridW) * dpr, scanY);
          scanGrad.addColorStop(0,   `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0)`);
          scanGrad.addColorStop(0.5, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${scanA})`);
          scanGrad.addColorStop(1,   `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0)`);
          ctx.strokeStyle = scanGrad;
          ctx.lineWidth   = 1.5 * dpr;
          ctx.beginPath();
          ctx.moveTo(gridLeft * dpr, scanY);
          ctx.lineTo((gridLeft + colGridW) * dpr, scanY);
          ctx.stroke();
        }
      }
    }

    // ── Center glow buildup during collapse ──────────────────

    if (t > tCollapse - 0.05) {
      const gt  = clamp01((t - tCollapse + 0.05) / P_COLLAPSE);
      const ga  = easeIn(gt) * 0.55;
      const gr  = lerp(3, 55, gt);
      if (ga > 0.005) {
        const grad = ctx.createRadialGradient(cx * dpr, cy * dpr, 0, cx * dpr, cy * dpr, gr * dpr);
        grad.addColorStop(0,   `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${ga})`);
        grad.addColorStop(0.4, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${ga * 0.35})`);
        grad.addColorStop(1,   `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0)`);
        ctx.beginPath();
        ctx.arc(cx * dpr, cy * dpr, gr * dpr, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }

    // ── Burst ring ───────────────────────────────────────────

    if (t > tBurst) {
      for (let ring = 0; ring < 2; ring++) {
        const bt  = clamp01((t - tBurst - ring * 0.08) / P_BURST);
        const ba  = (1 - bt) * (ring === 0 ? 0.4 : 0.2);
        const br  = bt * (ring === 0 ? 160 : 90);
        if (ba > 0.005) {
          ctx.beginPath();
          ctx.arc(cx * dpr, cy * dpr, br * dpr, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${ba})`;
          ctx.lineWidth   = (2.2 - bt * 1.8) * dpr;
          ctx.stroke();
        }
      }
    }

    // ── Callbacks ────────────────────────────────────────────

    if (t > tCollapse + 0.08 && !firedRef.current) {
      firedRef.current = true;
      onEmbeddingDone();
    }
    if (t > TOTAL && !doneRef.current) {
      doneRef.current = true;
      onComplete();
    }

    if (t < TOTAL + 0.5) {
      animRef.current = requestAnimationFrame(draw);
    }
  }, [onEmbeddingDone, onComplete]);

  /* ── Mount ──────────────────────────────────────────────────── */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    dprRef.current = dpr;
    const w = window.innerWidth;
    const h = window.innerHeight;
    sizeRef.current = { w, h };
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width  = `${w}px`;
    canvas.style.height = `${h}px`;

    init();
    t0Ref.current = null;
    animRef.current = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(animRef.current);
  }, [init, draw]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0"
      style={{ zIndex: 15 }}
      aria-hidden="true"
    />
  );
}
