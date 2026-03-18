"use client";

import { useRef, useEffect, useCallback } from "react";

interface Props {
  query: string;
  onEmbeddingDone: () => void;
  onComplete: () => void;
}

const ACCENT_R = 155, ACCENT_G = 27, ACCENT_B = 48;
const GLOW_R = 220, GLOW_G = 60, GLOW_B = 90;

// Phase durations — text analysis only, globe handled by NetworkBackground
const P_APPEAR    = 0.5;
const P_UNDERLINE = 1.8;
const P_DISSOLVE  = 1.0;
const P_CONVERGE  = 0.35;
const P_FLASH     = 0.15;
const TOTAL = P_APPEAR + P_UNDERLINE + P_DISSOLVE + P_CONVERGE + P_FLASH;

const PARTICLES_PER_WORD = 14;
const MOTE_COUNT = 25;

function clamp01(t: number) { return Math.max(0, Math.min(1, t)); }
function easeOut(t: number) { return 1 - (1 - t) * (1 - t) * (1 - t); }
function easeIn(t: number) { return t * t * t; }
function easeInOut(t: number) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

interface WordInfo { word: string; x: number; y: number; w: number; stagger: number; }
interface Particle { x: number; y: number; vx: number; vy: number; size: number; word: number; angle: number; dist: number; }
interface Mote { x: number; y: number; vx: number; vy: number; size: number; phase: number; speed: number; }

export default function SonarPulseAnimation({ query, onEmbeddingDone, onComplete }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef(0);
  const t0Ref = useRef<number | null>(null);
  const firedRef = useRef(false);
  const doneRef = useRef(false);
  const dprRef = useRef(1);
  const sizeRef = useRef({ w: 0, h: 0 });
  const wordsRef = useRef<WordInfo[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const motesRef = useRef<Mote[]>([]);

  /* ── Init ─────────────────────────────────────────────────── */

  const init = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = dprRef.current;
    const w = sizeRef.current.w;
    const h = sizeRef.current.h;
    const cx = w / 2;
    const cy = h / 2;

    const ctx = canvas.getContext("2d")!;
    const rawWords = query.split(/\s+/).filter(Boolean);
    const fontSize = Math.min(28, w * 0.035);
    ctx.font = `700 ${fontSize * dpr}px Tajawal, system-ui, sans-serif`;

    const gap = 14;
    const metrics = rawWords.map(wd => ({ wd, width: ctx.measureText(wd).width / dpr }));
    const totalW = metrics.reduce((s, m) => s + m.width, 0) + gap * (metrics.length - 1);
    let cursorX = cx + totalW / 2;

    const words: WordInfo[] = metrics.map((m, i) => {
      cursorX -= m.width;
      const x = cursorX + m.width / 2;
      cursorX -= gap;
      return { word: m.wd, x, y: cy, w: m.width, stagger: i / Math.max(1, rawWords.length - 1) };
    });

    // Particles per word
    const particles: Particle[] = [];
    for (let wi = 0; wi < words.length; wi++) {
      const wp = words[wi];
      for (let p = 0; p < PARTICLES_PER_WORD; p++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 2 + Math.random() * 8;
        particles.push({
          x: wp.x + (Math.random() - 0.5) * wp.w,
          y: wp.y + (Math.random() - 0.5) * 10,
          vx: Math.cos(angle) * (0.3 + Math.random() * 0.8),
          vy: Math.sin(angle) * (0.3 + Math.random() * 0.8),
          size: 1.2 + Math.random() * 2,
          word: wi,
          angle, dist,
        });
      }
    }

    // Ambient motes
    const motes: Mote[] = [];
    for (let i = 0; i < MOTE_COUNT; i++) {
      motes.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        size: 0.8 + Math.random() * 1.5,
        phase: Math.random() * Math.PI * 2,
        speed: 0.5 + Math.random() * 1.5,
      });
    }

    wordsRef.current = words;
    particlesRef.current = particles;
    motesRef.current = motes;
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

    const tUnder = P_APPEAR;
    const tDissolve = tUnder + P_UNDERLINE;
    const tConverge = tDissolve + P_DISSOLVE;
    const tFlash = tConverge + P_CONVERGE;

    const words = wordsRef.current;
    const particles = particlesRef.current;
    const motes = motesRef.current;
    const fontSize = Math.min(28, w * 0.035);

    // ── Soft vignette ─────────────────────────────────────────
    const vigAlpha = 0.04 + clamp01(t / TOTAL) * 0.06;
    const vig = ctx.createRadialGradient(cx * dpr, cy * dpr, 0, cx * dpr, cy * dpr, Math.max(w, h) * 0.7 * dpr);
    vig.addColorStop(0, `rgba(${ACCENT_R},${ACCENT_G},${ACCENT_B},0)`);
    vig.addColorStop(1, `rgba(${ACCENT_R},${ACCENT_G},${ACCENT_B},${vigAlpha})`);
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // ── Ambient motes ─────────────────────────────────────────
    for (const m of motes) {
      m.x += m.vx;
      m.y += m.vy;
      if (m.x < 0) m.x = w;
      if (m.x > w) m.x = 0;
      if (m.y < 0) m.y = h;
      if (m.y > h) m.y = 0;
      const ma = (0.15 + 0.1 * Math.sin(t * m.speed + m.phase)) * 0.5;
      ctx.beginPath();
      ctx.arc(m.x * dpr, m.y * dpr, m.size * dpr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${ACCENT_R},${ACCENT_G},${ACCENT_B},${ma})`;
      ctx.fill();
    }

    // ── Heartbeat pulse glow during scanning ──────────────────
    if (t > tUnder && t < tDissolve + 0.3) {
      const heartbeat = 0.15 + 0.1 * Math.sin(t * 4.5);
      const hbGrad = ctx.createRadialGradient(cx * dpr, cy * dpr, 0, cx * dpr, cy * dpr, 120 * dpr);
      hbGrad.addColorStop(0, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${heartbeat})`);
      hbGrad.addColorStop(1, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0)`);
      ctx.beginPath();
      ctx.arc(cx * dpr, cy * dpr, 120 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = hbGrad;
      ctx.fill();
    }

    // ── Words appear RTL ──────────────────────────────────────
    if (t < tDissolve + 0.3) {
      ctx.font = `700 ${fontSize * dpr}px Tajawal, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      for (let wi = 0; wi < words.length; wi++) {
        const wp = words[wi];
        const appearT = clamp01((t - wp.stagger * 0.1) / P_APPEAR);
        if (appearT <= 0) continue;
        const dissolveStart = tDissolve + wp.stagger * P_DISSOLVE * 0.2;
        const dissolveT = clamp01((t - dissolveStart) / (P_DISSOLVE * 0.5));
        const alpha = easeOut(appearT) * (1 - easeIn(dissolveT));
        if (alpha < 0.01) continue;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = `rgb(${ACCENT_R},${ACCENT_G},${ACCENT_B})`;
        ctx.fillText(wp.word, wp.x * dpr, wp.y * dpr);
        ctx.restore();
      }
    }

    // ── Gradient underlines + sweep ───────────────────────────
    if (t > tUnder * 0.7 && t < tDissolve + 0.2) {
      const underProgress = clamp01((t - tUnder * 0.7) / P_UNDERLINE);
      for (let wi = 0; wi < words.length; wi++) {
        const wp = words[wi];
        const wordStart = wi / words.length;
        const wordT = clamp01((underProgress - wordStart * 0.6) / 0.4);
        if (wordT <= 0) continue;

        const lineY = (wp.y + fontSize / 2 + 4) * dpr;
        const lineL = (wp.x - wp.w / 2) * dpr;
        const lineR = lineL + wp.w * dpr * easeOut(wordT);

        const grad = ctx.createLinearGradient(lineL, lineY, lineR, lineY);
        grad.addColorStop(0, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.1)`);
        grad.addColorStop(0.5, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.4)`);
        grad.addColorStop(1, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.15)`);
        ctx.beginPath();
        ctx.moveTo(lineL, lineY);
        ctx.lineTo(lineR, lineY);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();

        // Leading dot
        if (wordT < 0.95) {
          ctx.beginPath();
          ctx.arc(lineR, lineY, 2.5 * dpr, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.6)`;
          ctx.fill();
        }

        // Checkmark when done
        if (wordT >= 0.95) {
          const ckX = (wp.x + wp.w / 2 + 8) * dpr;
          const ckY = lineY;
          ctx.beginPath();
          ctx.moveTo(ckX - 3 * dpr, ckY);
          ctx.lineTo(ckX, ckY + 3 * dpr);
          ctx.lineTo(ckX + 5 * dpr, ckY - 4 * dpr);
          ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.5)`;
          ctx.lineWidth = 1.5 * dpr;
          ctx.stroke();
        }

        // Pulse ring on completion
        if (wordT > 0.9) {
          const ringAge = (wordT - 0.9) / 0.1;
          const ringR = (5 + ringAge * 20) * dpr;
          const ringA = (1 - ringAge) * 0.3;
          if (ringA > 0) {
            ctx.beginPath();
            ctx.arc(wp.x * dpr, wp.y * dpr, ringR, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${ringA})`;
            ctx.lineWidth = 1 * dpr;
            ctx.stroke();
          }
        }
      }
    }

    // ── Number fragments drifting up (encoding bridge) ────────
    if (t > tUnder + P_UNDERLINE * 0.3 && t < tDissolve + 0.4) {
      const numAge = t - (tUnder + P_UNDERLINE * 0.3);
      ctx.font = `500 ${8 * dpr}px 'SF Mono', 'Fira Code', monospace`;
      ctx.textAlign = "center";
      for (let wi = 0; wi < words.length; wi++) {
        const wp = words[wi];
        for (let n = 0; n < 3; n++) {
          const seed = wi * 10 + n;
          const x = wp.x + (seed % 5 - 2) * 12;
          const drift = numAge * (15 + (seed % 7) * 5);
          const y = wp.y - 20 - drift;
          const na = Math.max(0, 0.4 - numAge * 0.25) * clamp01(numAge * 3);
          if (na < 0.02) continue;
          const val = ((Math.sin(seed * 127.1) * 43758.5453) % 1).toFixed(2);
          ctx.fillStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${na})`;
          ctx.fillText((parseFloat(val) > 0.5 ? "-" : "") + val, x * dpr, y * dpr);
        }
      }
    }

    // ── Dissolve + particles ──────────────────────────────────
    if (t > tDissolve - 0.1 && t < tFlash + 0.2) {
      const dissProgress = clamp01((t - tDissolve) / P_DISSOLVE);
      const convProgress = clamp01((t - tConverge) / P_CONVERGE);

      for (const p of particles) {
        const wp = words[p.word];
        if (!wp) continue;

        let px: number, py: number, pa: number;

        if (t < tConverge) {
          // Scatter outward
          const scatter = easeOut(dissProgress);
          px = p.x + p.vx * scatter * 60;
          py = p.y + p.vy * scatter * 60;
          pa = clamp01(dissProgress * 3) * (1 - dissProgress * 0.3);
        } else {
          // Spiral converge to center
          const ct = easeInOut(convProgress);
          const scatterX = p.x + p.vx * 60;
          const scatterY = p.y + p.vy * 60;
          const spiralAngle = p.angle + ct * Math.PI * 3;
          const spiralDist = (1 - ct) * 60;
          const targetX = cx + Math.cos(spiralAngle) * spiralDist;
          const targetY = cy + Math.sin(spiralAngle) * spiralDist;
          px = lerp(scatterX, targetX, ct);
          py = lerp(scatterY, targetY, ct);
          pa = 1 - ct * 0.8;
        }

        if (pa < 0.02) continue;

        const glow = ctx.createRadialGradient(px * dpr, py * dpr, 0, px * dpr, py * dpr, p.size * 3 * dpr);
        glow.addColorStop(0, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${pa * 0.5})`);
        glow.addColorStop(1, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0)`);
        ctx.beginPath();
        ctx.arc(px * dpr, py * dpr, p.size * 3 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(px * dpr, py * dpr, p.size * dpr * (0.5 + pa * 0.5), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${ACCENT_R},${ACCENT_G},${ACCENT_B},${pa * 0.8})`;
        ctx.fill();
      }
    }

    // ── Flash burst ─────────────────────────────────────────
    if (t > tFlash) {
      const ft = clamp01((t - tFlash) / P_FLASH);
      const fa = (1 - ft) * 0.4;
      const fr = ft * 120;
      if (fa > 0) {
        ctx.beginPath();
        ctx.arc(cx * dpr, cy * dpr, fr * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${fa})`;
        ctx.lineWidth = (2.5 - ft * 2) * dpr;
        ctx.stroke();
      }
    }



    // ── Evolving status label ─────────────────────────────────
    if (t > tUnder + 0.2 && t < tDissolve + 0.5) {
      const la = clamp01((t - tUnder - 0.2) * 2) * clamp01(1 - (t - tDissolve) * 3) * 0.5;
      if (la > 0) {
        const label = t < tUnder + P_UNDERLINE * 0.5
          ? "قراءة الاستعلام..."
          : t < tDissolve - 0.1
            ? "تحليل المعنى..."
            : "ترميز البحث...";
        ctx.save();
        ctx.globalAlpha = la;
        ctx.font = `500 ${10 * dpr}px Tajawal, system-ui`;
        ctx.textAlign = "center";
        ctx.fillStyle = `rgba(${ACCENT_R},${ACCENT_G},${ACCENT_B},0.7)`;
        ctx.fillText(label, cx * dpr, (cy + 50) * dpr);

        const dotCount = 1 + Math.floor(t * 2.5) % 3;
        const dotsStr = ".".repeat(dotCount);
        const labelW = ctx.measureText(label).width;
        ctx.fillText(dotsStr, cx * dpr - labelW / 2 - 8 * dpr, (cy + 50) * dpr);
        ctx.restore();
      }
    }

    // ── Callbacks ───────────────────────────────────────────
    if (t > TOTAL && !firedRef.current) { firedRef.current = true; onEmbeddingDone(); }
    if (t > TOTAL && !doneRef.current) { doneRef.current = true; onComplete(); }
    animRef.current = requestAnimationFrame(draw);
  }, [query, onEmbeddingDone, onComplete]);

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

  return <canvas ref={canvasRef} className="fixed inset-0" style={{ zIndex: 15 }} aria-hidden="true" />;
}
