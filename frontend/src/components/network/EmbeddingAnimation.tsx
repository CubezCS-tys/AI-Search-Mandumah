"use client";

import { useRef, useEffect, useCallback } from "react";

/* ── Types ─────────────────────────────────────────────────── */

interface WordParticle {
  // The original Arabic word
  word: string;
  // Source position (text layout)
  sx: number;
  sy: number;
  // Scattered position (mid-phase drift)
  mx: number;
  my: number;
  // Stagger timing (0–1)
  stagger: number;
  // Spawned number fragments
  fragments: Fragment[];
}

interface Fragment {
  value: string;     // e.g. "-0.0412"
  // Position in vector column
  tx: number;
  ty: number;
  // Offset from word center for scatter phase
  ox: number;
  oy: number;
  stagger: number;   // additional per-fragment stagger
}

interface Props {
  query: string;
  onEmbeddingDone: () => void;
  onComplete: () => void;
}

/* ── Config ─────────────────────────────────────────────────── */

const ACCENT_R = 155, ACCENT_G = 27, ACCENT_B = 48;
const GLOW_R = 220, GLOW_G = 60, GLOW_B = 90;

// Phase durations (seconds) — total ~3.8s
const P_SHOW = 0.5;        // text fades in
const P_MORPH = 1.4;       // words dissolve into numbers
const P_FORM = 1.0;        // numbers flow into vector column
const P_COLLAPSE = 0.6;    // column collapses to center point
const P_BURST = 0.3;       // energy burst
const TOTAL = P_SHOW + P_MORPH + P_FORM + P_COLLAPSE + P_BURST;

const FRAGMENTS_PER_WORD = 5;
const VECTOR_COLS = 4;
const COL_WIDTH = 80;
const ROW_HEIGHT = 16;

/* ── Helpers ────────────────────────────────────────────────── */

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function clamp01(t: number) {
  return Math.max(0, Math.min(1, t));
}

function easeOut(t: number) {
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

function easeIn(t: number) {
  return t * t * t;
}

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function seededRand(seed: number) {
  // Simple deterministic hash
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function fakeVector(seed: number): string {
  const v = (seededRand(seed) - 0.5) * 0.2;
  return (v >= 0 ? " " : "") + v.toFixed(4);
}

/* ── Component ──────────────────────────────────────────────── */

export default function EmbeddingAnimation({ query, onEmbeddingDone, onComplete }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef(0);
  const t0Ref = useRef<number | null>(null);
  const wordsRef = useRef<WordParticle[]>([]);
  const streamNumbersRef = useRef<{ value: string; row: number; col: number; delay: number }[]>([]);
  const firedRef = useRef(false);
  const doneRef = useRef(false);
  const dprRef = useRef(1);
  const sizeRef = useRef({ w: 0, h: 0 });

  /* ── Initialize ───────────────────────────────────────────── */

  const init = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = dprRef.current;
    const w = sizeRef.current.w;
    const h = sizeRef.current.h;
    const cx = w / 2;
    const cy = h / 2;

    // Measure words
    const rawWords = query.split(/\s+/).filter(Boolean);
    const fontSize = Math.min(30, w * 0.035);
    ctx.font = `700 ${fontSize * dpr}px Tajawal, system-ui, sans-serif`;

    const wordWidths = rawWords.map(w => ctx.measureText(w).width / dpr);
    const gap = 12;
    const totalTextW = wordWidths.reduce((s, w) => s + w, 0) + gap * (rawWords.length - 1);
    let cursor = cx + totalTextW / 2; // RTL

    // Total fragments for vector column layout
    const totalFragments = rawWords.length * FRAGMENTS_PER_WORD;
    const rows = Math.ceil(totalFragments / VECTOR_COLS);
    const colStartX = cx - (VECTOR_COLS * COL_WIDTH) / 2;
    const colStartY = cy - (rows * ROW_HEIGHT) / 2;

    let fragIdx = 0;
    const words: WordParticle[] = rawWords.map((word, i) => {
      cursor -= wordWidths[i];
      const wordCx = cursor + wordWidths[i] / 2;
      cursor -= gap;

      const stagger = i / rawWords.length;

      const fragments: Fragment[] = [];
      for (let f = 0; f < FRAGMENTS_PER_WORD; f++) {
        const col = fragIdx % VECTOR_COLS;
        const row = Math.floor(fragIdx / VECTOR_COLS);
        fragments.push({
          value: fakeVector(i * 100 + f),
          tx: colStartX + col * COL_WIDTH + COL_WIDTH / 2,
          ty: colStartY + row * ROW_HEIGHT,
          ox: seededRand(i * 10 + f + 0.5) * 40 - 20,
          oy: seededRand(i * 10 + f + 0.9) * 30 - 15,
          stagger: f / FRAGMENTS_PER_WORD,
        });
        fragIdx++;
      }

      return {
        word,
        sx: wordCx,
        sy: cy,
        mx: wordCx + (seededRand(i + 0.3) - 0.5) * 60,
        my: cy + (seededRand(i + 0.7) - 0.5) * 40,
        stagger,
        fragments,
      };
    });

    // Extra streaming numbers that fill the column beyond the word-fragments
    const extra: typeof streamNumbersRef.current = [];
    const extraCount = Math.min(80, rows * VECTOR_COLS - fragIdx);
    for (let i = 0; i < extraCount; i++) {
      const col = (fragIdx + i) % VECTOR_COLS;
      const row = Math.floor((fragIdx + i) / VECTOR_COLS);
      extra.push({
        value: fakeVector(500 + i),
        row,
        col,
        delay: 0.2 + i * 0.008,
      });
    }

    wordsRef.current = words;
    streamNumbersRef.current = extra;
    firedRef.current = false;
    doneRef.current = false;
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
    const w = sizeRef.current.w;
    const h = sizeRef.current.h;
    const cx = w / 2;
    const cy = h / 2;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Phase boundaries
    const tMorph = P_SHOW;
    const tForm = tMorph + P_MORPH;
    const tCollapse = tForm + P_FORM;
    const tBurst = tCollapse + P_COLLAPSE;

    const words = wordsRef.current;
    const extras = streamNumbersRef.current;
    const totalFragments = words.length * FRAGMENTS_PER_WORD;
    const rows = Math.ceil((totalFragments + extras.length) / VECTOR_COLS);
    const colStartX = cx - (VECTOR_COLS * COL_WIDTH) / 2;
    const colStartY = cy - (rows * ROW_HEIGHT) / 2;

    // ── Labels ────────────────────────────────────────────────

    const labelSize = 11 * dpr;

    // "BGE-M3 Embedding" during morph
    if (t > tMorph * 0.8 && t < tForm + 0.3) {
      const fadeIn = clamp01((t - tMorph * 0.8) * 3);
      const fadeOut = clamp01(1 - (t - tForm) * 4);
      const a = Math.min(fadeIn, fadeOut) * 0.65;
      if (a > 0) {
        ctx.font = `500 ${labelSize}px Tajawal, system-ui`;
        ctx.textAlign = "center";
        ctx.fillStyle = `rgba(${ACCENT_R},${ACCENT_G},${ACCENT_B},${a})`;
        ctx.fillText("BGE-M3 Embedding", cx * dpr, (cy - 160) * dpr);
      }
    }

    // "Dense Vector [1024d]" during form
    if (t > tMorph + P_MORPH * 0.6 && t < tCollapse + 0.3) {
      const fadeIn = clamp01((t - tMorph - P_MORPH * 0.6) * 2.5);
      const fadeOut = clamp01(1 - (t - tCollapse) * 4);
      const a = Math.min(fadeIn, fadeOut) * 0.6;
      if (a > 0) {
        ctx.font = `600 ${12 * dpr}px 'SF Mono', 'Fira Code', monospace`;
        ctx.textAlign = "center";
        ctx.fillStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${a})`;
        ctx.fillText("float[1024]", cx * dpr, (colStartY - 30) * dpr);

        ctx.font = `400 ${10 * dpr}px Tajawal, system-ui`;
        ctx.fillStyle = `rgba(${ACCENT_R},${ACCENT_G},${ACCENT_B},${a * 0.5})`;
        ctx.fillText("+ sparse vector", cx * dpr, (colStartY - 14) * dpr);
      }
    }

    // ── Draw words & fragments ────────────────────────────────

    for (const wp of words) {
      const s = wp.stagger;

      // --- Word text (phase: show → morph) ---
      if (t < tForm) {
        // Fade in
        const showA = clamp01((t - s * 0.15) * 5);
        // Fade out during morph
        const morphT = clamp01((t - tMorph - s * P_MORPH * 0.3) / (P_MORPH * 0.5));
        const wordAlpha = showA * (1 - easeIn(morphT));

        if (wordAlpha > 0.005) {
          // Smooth drift during morph
          const drift = easeOut(clamp01((t - tMorph) / P_MORPH));
          const wx = lerp(wp.sx, wp.mx, drift * 0.4);
          const wy = lerp(wp.sy, wp.my, drift * 0.3);

          const fs = Math.min(30, sizeRef.current.w * 0.035);
          ctx.save();
          ctx.font = `700 ${fs * dpr}px Tajawal, system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.globalAlpha = wordAlpha;
          ctx.fillStyle = `rgb(${ACCENT_R},${ACCENT_G},${ACCENT_B})`;
          ctx.fillText(wp.word, wx * dpr, wy * dpr);
          ctx.restore();
        }
      }

      // --- Fragments (morph → form → collapse) ---
      for (const frag of wp.fragments) {
        const fragDelay = s * 0.3 + frag.stagger * 0.15;

        // Fragment fade in (during morph phase)
        const fragAppear = clamp01((t - tMorph - fragDelay * P_MORPH) / (P_MORPH * 0.4));
        if (fragAppear <= 0) continue;

        let fx: number, fy: number, fa: number, fScale: number;

        if (t < tForm) {
          // Morph phase: emerge from word position, drift outward
          const drift = easeOut(fragAppear);
          fx = lerp(wp.sx + frag.ox * 0.3, wp.mx + frag.ox, drift);
          fy = lerp(wp.sy + frag.oy * 0.3, wp.my + frag.oy, drift);
          fa = fragAppear * 0.8;
          fScale = lerp(0.5, 0.75, drift);
        } else if (t < tCollapse) {
          // Form phase: move to grid position
          const formT = easeInOut(clamp01((t - tForm) / P_FORM));
          const fromX = wp.mx + frag.ox;
          const fromY = wp.my + frag.oy;
          fx = lerp(fromX, frag.tx, formT);
          fy = lerp(fromY, frag.ty, formT);
          fa = lerp(0.8, 0.9, formT);
          fScale = lerp(0.75, 0.85, formT);
        } else if (t < tBurst) {
          // Collapse phase: converge to center
          const colT = easeIn(clamp01((t - tCollapse - frag.stagger * 0.1) / (P_COLLAPSE * 0.85)));
          fx = lerp(frag.tx, cx, colT);
          fy = lerp(frag.ty, cy, colT);
          fa = lerp(0.9, 0, colT);
          fScale = lerp(0.85, 0.15, colT);
        } else {
          continue; // gone
        }

        if (fa < 0.005) continue;

        ctx.save();
        ctx.translate(fx * dpr, fy * dpr);
        ctx.globalAlpha = fa;
        const numSize = 11 * fScale;
        ctx.font = `500 ${numSize * dpr}px 'SF Mono', 'Fira Code', monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${fa})`;
        ctx.fillText(frag.value, 0, 0);
        ctx.restore();
      }
    }

    // ── Extra streaming numbers ───────────────────────────────

    if (t > tMorph + P_MORPH * 0.7) {
      for (const ex of extras) {
        const exX = colStartX + ex.col * COL_WIDTH + COL_WIDTH / 2;
        const exY = colStartY + ex.row * ROW_HEIGHT;

        let ea: number, epx: number, epy: number, eScale: number;

        if (t < tForm) {
          const fadeT = clamp01((t - tMorph - P_MORPH * 0.7 - ex.delay) * 3);
          ea = fadeT * 0.35;
          epx = exX + (1 - fadeT) * (seededRand(ex.row * 10 + ex.col) - 0.5) * 100;
          epy = exY + (1 - fadeT) * (seededRand(ex.row * 10 + ex.col + 5) - 0.5) * 60;
          eScale = 0.6;
        } else if (t < tCollapse) {
          const formT = easeInOut(clamp01((t - tForm) / P_FORM));
          const startX = exX + (seededRand(ex.row * 10 + ex.col) - 0.5) * 100;
          const startY = exY + (seededRand(ex.row * 10 + ex.col + 5) - 0.5) * 60;
          epx = lerp(startX, exX, formT);
          epy = lerp(startY, exY, formT);
          ea = lerp(0.35, 0.5, formT);
          eScale = lerp(0.6, 0.75, formT);
        } else if (t < tBurst) {
          const colT = easeIn(clamp01((t - tCollapse) / (P_COLLAPSE * 0.8)));
          epx = lerp(exX, cx, colT);
          epy = lerp(exY, cy, colT);
          ea = lerp(0.5, 0, colT);
          eScale = lerp(0.75, 0.1, colT);
        } else {
          continue;
        }

        if (ea < 0.005) continue;

        ctx.save();
        ctx.translate(epx * dpr, epy * dpr);
        ctx.globalAlpha = ea;
        ctx.font = `400 ${9 * eScale * dpr}px 'SF Mono', 'Fira Code', monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = `rgba(${ACCENT_R},${ACCENT_G},${ACCENT_B},${ea * 0.7})`;
        ctx.fillText(ex.value, 0, 0);
        ctx.restore();
      }
    }

    // ── Vector bracket decoration during form phase ───────────

    if (t > tForm - 0.2 && t < tBurst) {
      const bracketA = clamp01((t - tForm + 0.2) * 2) * clamp01(1 - (t - tCollapse) * 3) * 0.25;
      if (bracketA > 0) {
        const colEndY = colStartY + rows * ROW_HEIGHT;
        const bracketX1 = (colStartX - 10) * dpr;
        const bracketX2 = (colStartX + VECTOR_COLS * COL_WIDTH + 10) * dpr;
        const by1 = (colStartY - 10) * dpr;
        const by2 = (colEndY + 5) * dpr;
        const bw = 6 * dpr;

        ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${bracketA})`;
        ctx.lineWidth = 1.5 * dpr;
        ctx.lineCap = "round";

        // Left bracket [
        ctx.beginPath();
        ctx.moveTo(bracketX1 + bw, by1);
        ctx.lineTo(bracketX1, by1);
        ctx.lineTo(bracketX1, by2);
        ctx.lineTo(bracketX1 + bw, by2);
        ctx.stroke();

        // Right bracket ]
        ctx.beginPath();
        ctx.moveTo(bracketX2 - bw, by1);
        ctx.lineTo(bracketX2, by1);
        ctx.lineTo(bracketX2, by2);
        ctx.lineTo(bracketX2 - bw, by2);
        ctx.stroke();
      }
    }

    // ── Center glow during collapse ──────────────────────────

    if (t > tCollapse - 0.1) {
      const gt = clamp01((t - tCollapse + 0.1) / P_COLLAPSE);
      const ga = easeIn(gt) * 0.5;
      const gr = lerp(4, 50, gt);

      if (ga > 0) {
        const grad = ctx.createRadialGradient(
          cx * dpr, cy * dpr, 0,
          cx * dpr, cy * dpr, gr * dpr
        );
        grad.addColorStop(0, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${ga})`);
        grad.addColorStop(0.5, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${ga * 0.3})`);
        grad.addColorStop(1, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0)`);
        ctx.beginPath();
        ctx.arc(cx * dpr, cy * dpr, gr * dpr, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }

    // ── Burst ring ───────────────────────────────────────────

    if (t > tBurst) {
      const bt = clamp01((t - tBurst) / P_BURST);
      const ba = (1 - bt) * 0.35;
      const br = bt * 150;

      if (ba > 0) {
        ctx.beginPath();
        ctx.arc(cx * dpr, cy * dpr, br * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${ba})`;
        ctx.lineWidth = (2 - bt * 1.5) * dpr;
        ctx.stroke();
      }
    }

    // ── Callbacks ────────────────────────────────────────────

    if (t > tCollapse + 0.1 && !firedRef.current) {
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
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
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
