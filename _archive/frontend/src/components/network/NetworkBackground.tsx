"use client";

import {
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";

/* ── Types ─────────────────────────────────────────────────── */

interface Node3D {
  theta: number;
  phi: number;
  px: number;
  py: number;
  pz: number;
  radius: number;
  cluster: number;
  brightness: number;
  pulseDelay: number;
}

interface Edge {
  a: number;
  b: number;
  activated: boolean;
  activateTime: number;
}

export interface NetworkHandle {
  triggerSearch: (scores?: number[]) => Promise<void>;
  startIdlePulse: () => void;
  getResultPositions: () => { x: number; y: number }[];
}

/* ── Config ─────────────────────────────────────────────────── */

const NODE_COUNT = 300;
const CLUSTER_COUNT = 8;
const EDGE_ARC_DIST = 0.45;
const INNER_CLUSTER_EDGE_DIST = 0.55;

const GLOW_R   = 220, GLOW_G   = 60,  GLOW_B   = 90;
const BASE_R   = 155, BASE_G   = 27,  BASE_B   = 48;
const ACCENT_R = 190, ACCENT_G = 100, ACCENT_B = 60; // sparse-wave warm tint

const CLUSTER_CENTERS = [
  { theta: 0.3, phi: 0.8 },
  { theta: 1.2, phi: 1.2 },
  { theta: 2.1, phi: 0.7 },
  { theta: 3.0, phi: 1.5 },
  { theta: 3.8, phi: 0.9 },
  { theta: 4.7, phi: 1.8 },
  { theta: 5.5, phi: 1.1 },
  { theta: 0.8, phi: 2.0 },
];

/* ── Helpers ────────────────────────────────────────────────── */

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function clamp01(t: number) {
  return Math.max(0, Math.min(1, t));
}

function seededRand(seed: number) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function gaussRand(seed: number) {
  const u = Math.max(0.0001, seededRand(seed));
  const v = seededRand(seed + 0.5);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sphereDist(t1: number, p1: number, t2: number, p2: number) {
  const x1 = Math.sin(p1) * Math.cos(t1), y1 = Math.sin(p1) * Math.sin(t1), z1 = Math.cos(p1);
  const x2 = Math.sin(p2) * Math.cos(t2), y2 = Math.sin(p2) * Math.sin(t2), z2 = Math.cos(p2);
  return Math.acos(Math.min(1, Math.max(-1, x1 * x2 + y1 * y2 + z1 * z2)));
}

function projectNode(
  node: Node3D, rotY: number, rotX: number,
  R: number, cx: number, cy: number, persp: number
) {
  let x = Math.sin(node.phi) * Math.cos(node.theta);
  let y = Math.cos(node.phi);
  let z = Math.sin(node.phi) * Math.sin(node.theta);

  // Rotate Y
  const cy2 = Math.cos(rotY), sy = Math.sin(rotY);
  const rx = x * cy2 - z * sy;
  const rz = x * sy + z * cy2;
  x = rx; z = rz;

  // Rotate X
  const cx2 = Math.cos(rotX), sx = Math.sin(rotX);
  const ry = y * cx2 - z * sx;
  const rz2 = y * sx + z * cx2;
  y = ry; z = rz2;

  x *= R; y *= R; z *= R;

  const s = persp / (persp + z);
  node.px = cx + x * s;
  node.py = cy + y * s;
  node.pz = z;
}

/* ── Component ──────────────────────────────────────────────── */

/** Build a random walk through the node graph, ~pathLen nodes. */
function buildJourneyPath(
  nodes: Node3D[],
  edges: Edge[],
  pathLen: number,
): number[] {
  // Build adjacency list
  const adj: number[][] = Array.from({ length: nodes.length }, () => []);
  for (const e of edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  // Start from a random well-connected node near the front
  const candidates = nodes
    .map((n, i) => ({ i, conns: adj[i].length, phi: n.phi }))
    .filter((c) => c.conns >= 3 && c.phi > 0.5 && c.phi < 2.5)
    .sort((a, b) => b.conns - a.conns);
  const start = candidates.length > 0
    ? candidates[Math.floor(Math.random() * Math.min(10, candidates.length))].i
    : Math.floor(Math.random() * nodes.length);

  const visited = new Set<number>();
  const path: number[] = [start];
  visited.add(start);

  let current = start;
  for (let step = 1; step < pathLen; step++) {
    const neighbors = adj[current].filter((n) => !visited.has(n));
    if (neighbors.length === 0) {
      // Jump to a random unvisited connected node from any visited node
      let jumped = false;
      for (const v of visited) {
        const opts = adj[v].filter((n) => !visited.has(n));
        if (opts.length > 0) {
          current = opts[Math.floor(Math.random() * opts.length)];
          path.push(current);
          visited.add(current);
          jumped = true;
          break;
        }
      }
      if (!jumped) break;
    } else {
      // Prefer neighbors in a different cluster for visual variety
      const diffCluster = neighbors.filter((n) => nodes[n].cluster !== nodes[current].cluster);
      const pool = diffCluster.length > 0 && Math.random() > 0.4 ? diffCluster : neighbors;
      current = pool[Math.floor(Math.random() * pool.length)];
      path.push(current);
      visited.add(current);
    }
  }
  return path;
}

const NetworkBackground = forwardRef<NetworkHandle>(function NetworkBackground(_, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Node3D[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const animRef = useRef(0);
  const prevTRef = useRef(0);     // previous timestamp (ms)
  const elapsedRef = useRef(0);   // total elapsed (seconds)
  const searchActiveRef = useRef(false);
  const searchStartRef = useRef(0);
  const resolveRef = useRef<(() => void) | null>(null);
  const rotRef = useRef({ y: 0, x: 0.35 });
  const zoomRef = useRef({ current: 1, target: 1 });
  const dprRef = useRef(1);
  const sizeRef = useRef({ w: 0, h: 0 });
  const resultIndicesRef = useRef<number[]>([]);
  const resultScoresRef  = useRef<number[]>([]);
  const hnswPathsRef     = useRef<number[][]>([]);
  const resultScreenPosRef = useRef<{ x: number; y: number }[]>([]);
  const logoImgRef = useRef<HTMLImageElement | null>(null);
  const idlePulseRef = useRef(false);
  const idlePulseStartRef = useRef(0);

  /* Journey state — traveler moving through the network */
  const journeyRef = useRef({
    active: false,
    startTime: 0,
    /** Ordered list of node indices the traveler visits */
    path: [] as number[],
    /** Current segment index (which edge of the path we're on) */
    segment: 0,
    /** Progress within current segment [0,1] */
    segProgress: 0,
    /** Camera target rotation (we slowly steer toward traveler) */
    camTargetY: 0,
    camTargetX: 0,
    /** Trail: recently visited node indices with timestamps */
    trail: [] as { idx: number; time: number }[],
    /** Burst rings from visited nodes */
    bursts: [] as { idx: number; time: number }[],
  });

  /* ── Init ──────────────────────────────────────────────────── */

  const initNetwork = useCallback(() => {
    const nodes: Node3D[] = [];
    for (let i = 0; i < NODE_COUNT; i++) {
      const cluster = i % CLUSTER_COUNT;
      const c = CLUSTER_CENTERS[cluster];
      const spread = 0.35;
      let theta = c.theta + gaussRand(i) * spread;
      let phi = c.phi + gaussRand(i + 500) * spread * 0.6;
      phi = Math.max(0.15, Math.min(Math.PI - 0.15, phi));
      theta = ((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

      nodes.push({
        theta, phi, px: 0, py: 0, pz: 0,
        radius: 1.5 + seededRand(i + 0.3) * 2,
        cluster, brightness: 0, pulseDelay: 0,
      });
    }

    const edges: Edge[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const d = sphereDist(nodes[i].theta, nodes[i].phi, nodes[j].theta, nodes[j].phi);
        const same = nodes[i].cluster === nodes[j].cluster;
        if (d < (same ? INNER_CLUSTER_EDGE_DIST : EDGE_ARC_DIST)) {
          edges.push({ a: i, b: j, activated: false, activateTime: 0 });
        }
      }
    }

    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, []);

  /* ── Trigger search ────────────────────────────────────────── */

  useImperativeHandle(ref, () => ({
    getResultPositions: () => resultScreenPosRef.current,
    startIdlePulse: () => {
      // Start the journey: build a path and begin traveling
      idlePulseRef.current = true;
      idlePulseStartRef.current = elapsedRef.current;

      const j = journeyRef.current;
      j.active = true;
      j.startTime = elapsedRef.current;
      j.path = buildJourneyPath(nodesRef.current, edgesRef.current, 40);
      j.segment = 0;
      j.segProgress = 0;
      j.trail = [];
      j.bursts = [];
      // Start zoomed in
      zoomRef.current.target = 2.2;

      // Snap camera to the first node so there's no violent initial spin
      if (j.path.length > 0) {
        const n = nodesRef.current[j.path[0]];
        const targetY = Math.PI / 2 - n.theta;
        const targetX = Math.PI / 2 - n.phi;
        j.camTargetY = targetY;
        j.camTargetX = targetX;
        // Also snap rotation immediately so we don't spin wildly to reach it
        rotRef.current.y = targetY;
        rotRef.current.x = targetX;
      }
    },
    triggerSearch: (scores?: number[]) => new Promise<void>((resolve) => {
      // Stop idle pulse & journey, start real search
      idlePulseRef.current = false;
      journeyRef.current.active = false;
      searchActiveRef.current = true;
      searchStartRef.current = elapsedRef.current;
      resolveRef.current = resolve;
      // Zoom back out for the real search view
      zoomRef.current.target = 1.45;

      const nodes = nodesRef.current;
      const edges = edgesRef.current;

      // Store real scores
      if (scores && scores.length > 0) {
        resultScoresRef.current = scores.slice(0, 5);
      } else {
        resultScoresRef.current = [];
      }

      // Pick 5 deterministic "result" nodes spread across clusters
      const targetClusters = [1, 3, 5, 0, 6];
      const resultIndices: number[] = [];
      for (const tc of targetClusters) {
        let best = -1, bestZ = Infinity;
        nodes.forEach((n, i) => {
          if (n.cluster === tc && n.pz < bestZ && !resultIndices.includes(i)) {
            bestZ = n.pz;
            best = i;
          }
        });
        if (best >= 0) resultIndices.push(best);
      }
      resultIndicesRef.current = resultIndices;

      // Build HNSW-like hop paths via BFS on edge adjacency
      const adj = new Map<number, number[]>();
      for (const e of edges) {
        if (!adj.has(e.a)) adj.set(e.a, []);
        if (!adj.has(e.b)) adj.set(e.b, []);
        adj.get(e.a)!.push(e.b);
        adj.get(e.b)!.push(e.a);
      }

      const paths: number[][] = [];
      for (const ri of resultIndices) {
        const path = [ri];
        let current = ri;
        for (let step = 0; step < 3; step++) {
          const neighbors = adj.get(current) || [];
          const next = neighbors.find(n => !path.includes(n));
          if (next === undefined) break;
          path.push(next);
          current = next;
        }
        paths.push(path.reverse());
      }
      hnswPathsRef.current = paths;

      // Each result node gets a staggered "beam arrival" time
      resultIndices.forEach((ni, rank) => {
        nodes[ni].pulseDelay = rank * 0.28;
      });

      // Non-result nodes get a later, softer delay for ripple propagation
      nodes.forEach((n, i) => {
        if (!resultIndices.includes(i)) {
          const minDist = resultIndices.reduce((best, ri) => {
            const d = sphereDist(n.theta, n.phi, nodes[ri].theta, nodes[ri].phi);
            return Math.min(best, d);
          }, Math.PI);
          n.pulseDelay = 0.6 + (minDist / Math.PI) * 1.2;
        }
      });

      zoomRef.current.target = 1.45;
    }),
  }), []);

  /* ── Draw ──────────────────────────────────────────────────── */

  const draw = useCallback((now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Real delta time (capped to avoid spiral-of-death on tab switch)
    if (prevTRef.current === 0) prevTRef.current = now;
    const rawDt = (now - prevTRef.current) / 1000;
    const dt = Math.min(rawDt, 0.05); // cap at 50ms
    prevTRef.current = now;
    elapsedRef.current += dt;
    const t = elapsedRef.current;

    const dpr = dprRef.current;
    const w = sizeRef.current.w;
    const h = sizeRef.current.h;
    const cx = w * dpr / 2;
    const cy = h * dpr / 2;
    const R = Math.min(w, h) * 0.38;
    const Rdpr = R * dpr;
    const persp = R * 2.8;

    // Zoom — smooth exponential interpolation using dt
    const zoom = zoomRef.current;
    const zoomSpeed = 3;
    if (searchActiveRef.current) {
      const elapsed = t - searchStartRef.current;
      zoom.current += (zoom.target - zoom.current) * (1 - Math.exp(-zoomSpeed * dt));

      if (elapsed > 3.8) {
        searchActiveRef.current = false;
        resolveRef.current?.();
        resolveRef.current = null;
      }
    } else if (idlePulseRef.current) {
      // Journey mode: zoom toward traveler, smoothly steer camera
      const j = journeyRef.current;
      zoom.current += (zoom.target - zoom.current) * (1 - Math.exp(-zoomSpeed * dt));

      if (j.active && j.path.length > 1) {
        // Advance traveler: ~0.9s per segment
        const SEG_DURATION = 0.9;
        j.segProgress += dt / SEG_DURATION;

        while (j.segProgress >= 1 && j.segment < j.path.length - 2) {
          j.segProgress -= 1;
          j.segment++;
          // Record trail
          const visitedIdx = j.path[j.segment];
          j.trail.push({ idx: visitedIdx, time: t });
          // Record burst
          j.bursts.push({ idx: visitedIdx, time: t });
          // Keep trail limited
          if (j.trail.length > 12) j.trail.shift();
          if (j.bursts.length > 20) j.bursts.shift();
        }

        // Clamp at end of path, then loop
        if (j.segment >= j.path.length - 2 && j.segProgress >= 1) {
          j.path = buildJourneyPath(nodesRef.current, edgesRef.current, 40);
          j.segment = 0;
          j.segProgress = 0;
        }

        // Steer camera toward current node
        const curNode = nodesRef.current[j.path[j.segment]];
        j.camTargetY = Math.PI / 2 - curNode.theta;
        j.camTargetX = Math.PI / 2 - curNode.phi;
      }
    } else {
      zoom.target = 1;
      zoom.current += (1 - zoom.current) * (1 - Math.exp(-zoomSpeed * 0.8 * dt));
    }

    // Rotation (dt-based)
    const rot = rotRef.current;
    if (idlePulseRef.current && journeyRef.current.active) {
      // Smoothly steer camera to follow the traveling pulse
      const j = journeyRef.current;
      const steerSpeed = 1 - Math.exp(-3.0 * dt);
      // Wrap angle difference to [-PI, PI] to avoid 360° spins
      let dy = j.camTargetY - rot.y;
      dy = dy - Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
      let dx = j.camTargetX - rot.x;
      dx = dx - Math.round(dx / (Math.PI * 2)) * Math.PI * 2;
      rot.y += dy * steerSpeed;
      rot.x += dx * steerSpeed;
    } else {
      const rotSpeed = searchActiveRef.current ? 0.18 : idlePulseRef.current ? 0.14 : 0.09;
      rot.y += rotSpeed * dt;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(zoom.current, zoom.current);
    ctx.translate(-cx, -cy);

    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    const searchT = searchActiveRef.current ? t - searchStartRef.current : -1;

    // Project nodes
    for (const node of nodes) {
      projectNode(node, rot.y, rot.x, R, w / 2, h / 2, persp);
      node.px *= dpr;
      node.py *= dpr;
    }

    // Update result screen positions (CSS px, zoom-adjusted)
    if (searchActiveRef.current) {
      const zc = zoom.current;
      resultScreenPosRef.current = resultIndicesRef.current.map(ni => {
        const n = nodes[ni];
        const cssX = n.px / dpr;
        const cssY = n.py / dpr;
        return {
          x: w / 2 + (cssX - w / 2) * zc,
          y: h / 2 + (cssY - h / 2) * zc,
        };
      });
    } else {
      resultScreenPosRef.current = [];
    }

    for (let ni = 0; ni < nodes.length; ni++) {
      const node = nodes[ni];
      // Brightness (dt-based smooth decay)
      if (searchActiveRef.current && searchT >= 0) {
        const at = searchT - node.pulseDelay;
        if (at > 0) {
          const wave = Math.exp(-at * 2) * Math.sin(at * 5);
          const glow = Math.exp(-at * 1.0) * 0.6;
          node.brightness = Math.max(0, wave) + glow;
        }
      } else if (idlePulseRef.current) {
        // Journey mode: nodes in the trail glow, traveler's current pair bright
        const j = journeyRef.current;
        let br = 0;
        if (j.active) {
          // Check if this node is in the trail
          for (const tr of j.trail) {
            if (tr.idx === ni) {
              const age = t - tr.time;
              br = Math.max(br, 0.5 * Math.exp(-age * 0.6));
            }
          }
          // Current segment endpoints glow bright
          if (j.path.length > 1 && j.segment < j.path.length - 1) {
            const iA = j.path[j.segment];
            const iB = j.path[j.segment + 1];
            if (ni === iA) br = Math.max(br, 0.7);
            if (ni === iB) br = Math.max(br, 0.4 + j.segProgress * 0.4);
          }
        }
        // Gentle ambient
        const ambient = 0.04 + 0.02 * Math.sin(t * 1.5 + node.theta * 3);
        node.brightness = Math.max(ambient, br);
      } else {
        node.brightness *= Math.exp(-6 * dt); // smooth exponential decay
      }
    }

    // ── Globe wireframe ──────────────────────────────────────

    // Outline
    ctx.beginPath();
    ctx.arc(cx, cy, Rdpr, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${BASE_R},${BASE_G},${BASE_B},0.055)`;
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();

    // Meridians
    for (let i = 0; i < 8; i++) {
      const theta = (Math.PI * 2 / 8) * i + rot.y;
      ctx.beginPath();
      let drawing = false;
      for (let j = 0; j <= 48; j++) {
        const phi = (Math.PI / 48) * j;
        let x = Math.sin(phi) * Math.cos(theta);
        let y = Math.cos(phi);
        let z = Math.sin(phi) * Math.sin(theta);
        const cx2 = Math.cos(rot.x), sx = Math.sin(rot.x);
        const ny = y * cx2 - z * sx;
        const nz = y * sx + z * cx2;
        y = ny; z = nz;

        if (z > 0.05) { drawing = false; continue; }

        const s = persp / (persp + z * R);
        const px = cx + x * Rdpr * s;
        const py = cy + y * Rdpr * s;

        if (!drawing) { ctx.moveTo(px, py); drawing = true; }
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = `rgba(${BASE_R},${BASE_G},${BASE_B},0.03)`;
      ctx.lineWidth = 0.6 * dpr;
      ctx.stroke();
    }

    // Latitudes
    for (let i = 1; i < 6; i++) {
      const phi = (Math.PI / 6) * i;
      const ringR = Math.sin(phi) * R;
      const ringY = Math.cos(phi) * R;
      const cx2 = Math.cos(rot.x), sx = Math.sin(rot.x);
      const ty = ringY * cx2;
      const tz = ringY * sx;

      if (tz < R * 0.5) {
        const s = persp / (persp + tz);
        ctx.beginPath();
        ctx.ellipse(cx, cy + ty * s * dpr, ringR * s * dpr, ringR * s * dpr * 0.15, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${BASE_R},${BASE_G},${BASE_B},${Math.max(0, 0.035 - tz / R * 0.02)})`;
        ctx.lineWidth = 0.6 * dpr;
        ctx.stroke();
      }
    }

    // ── Edges ────────────────────────────────────────────────

    // Activate edges
    if (searchActiveRef.current) {
      for (const e of edges) {
        if (!e.activated && (nodes[e.a].brightness > 0.2 || nodes[e.b].brightness > 0.2)) {
          e.activated = true;
          e.activateTime = t;
        }
      }
    } else {
      for (const e of edges) e.activated = false;
    }

    // Batch edges by approximate alpha for fewer style changes
    for (const e of edges) {
      const na = nodes[e.a], nb = nodes[e.b];
      if (na.pz > 0 && nb.pz > 0) continue;

      const dA = clamp01(1 - (na.pz + R) / (R * 2));
      const dB = clamp01(1 - (nb.pz + R) / (R * 2));
      const depth = Math.min(dA, dB);

      let alpha = depth * 0.06;
      let r = BASE_R, g = BASE_G, b = BASE_B;

      if (e.activated) {
        const pulse = Math.exp(-(t - e.activateTime) * 2.5) * 0.65;
        alpha += pulse * depth;
        r = lerp(BASE_R, GLOW_R, pulse);
        g = lerp(BASE_G, GLOW_G, pulse);
        b = lerp(BASE_B, GLOW_B, pulse);
      }

      if (alpha < 0.004) continue;

      ctx.beginPath();
      ctx.moveTo(na.px, na.py);
      ctx.lineTo(nb.px, nb.py);
      ctx.strokeStyle = `rgba(${r | 0},${g | 0},${b | 0},${alpha})`;
      ctx.lineWidth = (e.activated ? 1.4 : 0.7) * dpr;
      ctx.stroke();
    }

    // ── Nodes (depth-sorted) ─────────────────────────────────

    // Pre-allocate sorted array once, sort in place
    const sorted = nodes.slice().sort((a, b) => b.pz - a.pz);

    for (const node of sorted) {
      const depth = clamp01(1 - (node.pz + R) / (R * 2));
      if (depth < 0.05) continue;

      const br = node.brightness;
      const r = lerp(BASE_R, GLOW_R, br);
      const g = lerp(BASE_G, GLOW_G, br);
      const b = lerp(BASE_B, GLOW_B, br);
      const alpha = (0.08 + depth * 0.18 + br * 0.65) * depth;
      const size = node.radius * dpr * (0.4 + depth * 0.8) * (1 + br * 0.35);

      // Glow
      if (br > 0.08 && depth > 0.25) {
        const gr = size * (3 + br * 4);
        const grad = ctx.createRadialGradient(node.px, node.py, 0, node.px, node.py, gr);
        grad.addColorStop(0, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${br * 0.25 * depth})`);
        grad.addColorStop(1, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0)`);
        ctx.beginPath();
        ctx.arc(node.px, node.py, gr, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(node.px, node.py, size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${alpha})`;
      ctx.fill();
    }

    // ── Journey traveler visualization ──────────────────────────

    if (idlePulseRef.current && !searchActiveRef.current) {
      const j = journeyRef.current;

      // Trail edges — glowing path showing where we've been
      for (let i = 1; i < j.trail.length; i++) {
        const pA = nodes[j.trail[i - 1].idx];
        const pB = nodes[j.trail[i].idx];
        const age = t - j.trail[i].time;
        const alpha = Math.max(0, 0.25 - age * 0.02);
        if (alpha > 0.005) {
          ctx.beginPath();
          ctx.moveTo(pA.px, pA.py);
          ctx.lineTo(pB.px, pB.py);
          ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${alpha})`;
          ctx.lineWidth = 1.5 * dpr;
          ctx.stroke();
        }
      }

      // Trail node markers — small glowing dots at visited nodes
      for (const tr of j.trail) {
        const trN = nodes[tr.idx];
        const age = t - tr.time;
        const a = Math.max(0, 0.35 - age * 0.04);
        if (a > 0.01) {
          ctx.beginPath();
          ctx.arc(trN.px, trN.py, 2.5 * dpr, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${a})`;
          ctx.fill();
        }
      }

      if (j.active && j.path.length > 1 && j.segment < j.path.length - 1) {
        const nA = nodes[j.path[j.segment]];
        const nB = nodes[j.path[j.segment + 1]];

        // Traveler position — interpolate with easing
        const tp = j.segProgress;
        const ease = tp < 0.5 ? 2 * tp * tp : 1 - Math.pow(-2 * tp + 2, 2) / 2;
        const tx = nA.px + (nB.px - nA.px) * ease;
        const ty = nA.py + (nB.py - nA.py) * ease;

        // ── Energy flow dashes along the current edge ──
        const edgeLen = Math.hypot(nB.px - nA.px, nB.py - nA.py);
        const dashCount = Math.max(3, Math.floor(edgeLen / (12 * dpr)));
        for (let d = 0; d < dashCount; d++) {
          // Each dash moves from A to B, staggered, cycling
          const dashT = ((t * 1.8 + d / dashCount) % 1);
          // Only draw dashes ahead of the traveler
          if (dashT > ease) {
            const dx = nA.px + (nB.px - nA.px) * dashT;
            const dy = nA.py + (nB.py - nA.py) * dashT;
            const distFromTrav = Math.abs(dashT - ease);
            const da = 0.3 * (1 - distFromTrav);
            if (da > 0.01) {
              ctx.beginPath();
              ctx.arc(dx, dy, 1.2 * dpr, 0, Math.PI * 2);
              ctx.fillStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${da})`;
              ctx.fill();
            }
          }
        }

        // ── Glow trail line (from A to traveler) ──
        const trailGrad = ctx.createLinearGradient(nA.px, nA.py, tx, ty);
        trailGrad.addColorStop(0, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.08)`);
        trailGrad.addColorStop(1, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.4)`);
        ctx.beginPath();
        ctx.moveTo(nA.px, nA.py);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = trailGrad;
        ctx.lineWidth = 2.5 * dpr;
        ctx.stroke();

        // Dimmer line ahead (traveler to B)
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(nB.px, nB.py);
        ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.08)`;
        ctx.lineWidth = 1 * dpr;
        ctx.stroke();

        // ── Outer breathing aura ──
        const breathe = 0.85 + 0.15 * Math.sin(t * 4);
        const auraR = 28 * dpr * breathe;
        const auraGrad = ctx.createRadialGradient(tx, ty, 0, tx, ty, auraR);
        auraGrad.addColorStop(0, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.25)`);
        auraGrad.addColorStop(0.35, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.10)`);
        auraGrad.addColorStop(0.7, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.03)`);
        auraGrad.addColorStop(1, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0)`);
        ctx.beginPath();
        ctx.arc(tx, ty, auraR, 0, Math.PI * 2);
        ctx.fillStyle = auraGrad;
        ctx.fill();

        // ── Spinning arc ring around traveler ──
        const ringR = 12 * dpr;
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(t * 2.5);
        ctx.beginPath();
        ctx.arc(0, 0, ringR, 0, Math.PI * 0.7);
        ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.35)`;
        ctx.lineWidth = 1.5 * dpr;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, ringR, Math.PI, Math.PI * 1.5);
        ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.2)`;
        ctx.lineWidth = 1 * dpr;
        ctx.stroke();
        ctx.restore();

        // ── Core traveler dot ──
        const coreGlow = ctx.createRadialGradient(tx, ty, 0, tx, ty, 6 * dpr);
        coreGlow.addColorStop(0, `rgba(255,255,255,0.9)`);
        coreGlow.addColorStop(0.4, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.8)`);
        coreGlow.addColorStop(1, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0)`);
        ctx.beginPath();
        ctx.arc(tx, ty, 6 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = coreGlow;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(tx, ty, 2.5 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,0.95)`;
        ctx.fill();

        // ── Spark particles trailing behind traveler ──
        for (let sp = 0; sp < 5; sp++) {
          const sparkAge = sp * 0.08;
          const sparkT = Math.max(0, ease - sparkAge * 0.5);
          const spx = nA.px + (nB.px - nA.px) * sparkT;
          const spy = nA.py + (nB.py - nA.py) * sparkT;
          // Offset each spark with a sin wave for spread
          const offX = Math.sin(t * 6 + sp * 2.1) * 4 * dpr;
          const offY = Math.cos(t * 5.5 + sp * 1.7) * 4 * dpr;
          const spAlpha = 0.4 * (1 - sp / 5);
          ctx.beginPath();
          ctx.arc(spx + offX, spy + offY, (1.5 - sp * 0.15) * dpr, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${spAlpha})`;
          ctx.fill();
        }
      }

      // ── Discovery bursts at visited nodes — double ring ──
      for (const burst of j.bursts) {
        const age = t - burst.time;
        if (age > 1.5) continue;
        const bNode = nodes[burst.idx];
        const progress = age / 1.5;

        // Outer ring — expands fast
        const r1 = (6 + progress * 35) * dpr;
        const a1 = (1 - progress) * 0.3;
        if (a1 > 0.005) {
          ctx.beginPath();
          ctx.arc(bNode.px, bNode.py, r1, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${a1})`;
          ctx.lineWidth = (2 - progress * 1.5) * dpr;
          ctx.stroke();
        }

        // Inner ring — delayed, smaller
        const innerAge = Math.max(0, age - 0.15);
        const ip = innerAge / 1.2;
        if (ip < 1) {
          const r2 = (3 + ip * 20) * dpr;
          const a2 = (1 - ip) * 0.2;
          ctx.beginPath();
          ctx.arc(bNode.px, bNode.py, r2, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,255,255,${a2})`;
          ctx.lineWidth = (1.5 - ip) * dpr;
          ctx.stroke();
        }

        // Brief bright flash at center
        if (age < 0.3) {
          const flashA = (1 - age / 0.3) * 0.5;
          const flashGrad = ctx.createRadialGradient(
            bNode.px, bNode.py, 0, bNode.px, bNode.py, 8 * dpr
          );
          flashGrad.addColorStop(0, `rgba(255,255,255,${flashA})`);
          flashGrad.addColorStop(1, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0)`);
          ctx.beginPath();
          ctx.arc(bNode.px, bNode.py, 8 * dpr, 0, Math.PI * 2);
          ctx.fillStyle = flashGrad;
          ctx.fill();
        }
      }
    }

    // ── Search visualization ─────────────────────────────────

    if (searchActiveRef.current && searchT >= 0) {
      const resultIndices = resultIndicesRef.current;

      // RRF timing: dense wave first, sparse wave 0.45s later
      const DENSE_START  = 0.05;
      const SPARSE_START = 0.50;
      const WAVE_DUR     = 0.55; // time for ring to reach globe edge

      // ── Change 4: RRF dual-wave rings ─────────────────────
      // Dense wave (solid, brighter)
      {
        const wt = searchT - DENSE_START;
        if (wt > 0 && wt < WAVE_DUR + 0.3) {
          const rp = clamp01(wt / WAVE_DUR);
          const rr = rp * Rdpr * 1.08;
          const ra = (1 - rp) * 0.45;
          if (ra > 0.005) {
            ctx.beginPath();
            ctx.arc(cx, cy, rr, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${ra})`;
            ctx.lineWidth   = 2 * dpr;
            ctx.setLineDash([]);
            ctx.stroke();
          }
        }
      }

      // Sparse wave (dashed, softer)
      {
        const wt = searchT - SPARSE_START;
        if (wt > 0 && wt < WAVE_DUR + 0.3) {
          const rp = clamp01(wt / WAVE_DUR);
          const rr = rp * Rdpr * 1.08;
          const ra = (1 - rp) * 0.28;
          if (ra > 0.005) {
            ctx.beginPath();
            ctx.arc(cx, cy, rr, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(${ACCENT_R},${ACCENT_G},${ACCENT_B},${ra})`;
            ctx.lineWidth   = 1.5 * dpr;
            ctx.setLineDash([6 * dpr, 8 * dpr]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }

      // ── Change 2: Simultaneous ring scan + top-5 stay lit ──
      // The dense wave's radius at this moment
      const waveFront      = clamp01((searchT - DENSE_START) / WAVE_DUR) * Rdpr * 1.08;
      const sparseWaveFront = clamp01((searchT - SPARSE_START) / WAVE_DUR) * Rdpr * 1.08;

      for (let ri = 0; ri < resultIndices.length; ri++) {
        const ni   = resultIndices[ri];
        const node = nodes[ni];

        // Distance from globe center (in canvas coords)
        const dx    = node.px - cx;
        const dy    = node.py - cy;
        const distC = Math.sqrt(dx * dx + dy * dy);

        // A node lights up when the wave front passes over it
        const hitByDense  = waveFront >= distC;
        const hitBySparse = sparseWaveFront >= distC;

        if (!hitByDense) continue;

        // How long has this node been lit (since the wave passed)?
        const wavePassT = (searchT - DENSE_START) - (distC / Rdpr) * WAVE_DUR;

        // ── Expanding ring on first contact ───────────────────
        const ringT = clamp01(wavePassT / 0.35);
        const ringR = (4 + ringT * 24) * dpr;
        const ringA = (1 - ringT) * 0.6;
        if (ringA > 0.01) {
          ctx.beginPath();
          ctx.arc(node.px, node.py, ringR, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${ringA})`;
          ctx.lineWidth   = (2 - ringT) * dpr;
          ctx.stroke();
        }

        // Extra double-ring on nodes hit by BOTH waves (RRF overlap)
        if (hitBySparse && wavePassT > 0.15) {
          const doubleAge = (searchT - SPARSE_START) - (distC / Rdpr) * WAVE_DUR;
          if (doubleAge > 0) {
            const dt2 = clamp01(doubleAge / 0.3);
            const dr  = (6 + dt2 * 18) * dpr;
            const da  = (1 - dt2) * 0.45;
            if (da > 0.01) {
              ctx.beginPath();
              ctx.arc(node.px, node.py, dr, 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(${ACCENT_R},${ACCENT_G},${ACCENT_B},${da})`;
              ctx.lineWidth   = 1.5 * dpr;
              ctx.stroke();
            }
          }
        }

        // ── Sustained glow (node stays lit) ───────────────────
        const pulse  = 0.5 + 0.5 * Math.sin(wavePassT * 6 + ri);
        const gR2    = (node.radius + 3 + pulse * 4) * dpr;
        const gGrad  = ctx.createRadialGradient(node.px, node.py, 0, node.px, node.py, gR2 * 3);
        const glowStr = hitBySparse ? 0.55 + pulse * 0.25 : 0.38 + pulse * 0.15;
        gGrad.addColorStop(0, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${glowStr})`);
        gGrad.addColorStop(1, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0)`);
        ctx.beginPath();
        ctx.arc(node.px, node.py, gR2 * 3, 0, Math.PI * 2);
        ctx.fillStyle = gGrad;
        ctx.fill();

        // ── Change 3: Rank badge (#1, #2...) instead of score + dashed lines ──
        const badgeAge = clamp01((wavePassT - 0.25) * 4);
        if (badgeAge > 0.05) {
          const badgeLabel = `#${ri + 1}`;
          const bx  = node.px + (node.radius + 8) * dpr;
          const by  = node.py - (node.radius + 8) * dpr;
          const fs  = 10 * dpr;
          const pad = 3.5 * dpr;

          ctx.font = `700 ${fs}px 'SF Mono', 'Fira Code', monospace`;
          const tw = ctx.measureText(badgeLabel).width;

          // Pill background
          ctx.save();
          ctx.globalAlpha = badgeAge * (0.75 + pulse * 0.12);
          ctx.fillStyle   = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.18)`;
          const pillX = bx - pad, pillY = by - fs * 0.85 - pad;
          const pillW = tw + pad * 2, pillH = fs + pad * 2;
          const pr    = 4 * dpr;
          ctx.beginPath();
          ctx.roundRect(pillX, pillY, pillW, pillH, pr);
          ctx.fill();

          // Pill border
          ctx.strokeStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0.45)`;
          ctx.lineWidth   = 1 * dpr;
          ctx.stroke();

          // Badge text
          ctx.fillStyle    = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},1)`;
          ctx.textAlign    = "left";
          ctx.textBaseline = "alphabetic";
          ctx.shadowBlur   = 0;
          ctx.fillText(badgeLabel, bx, by);
          ctx.restore();

          // Real score below badge
          const realScore = resultScoresRef.current[ri];
          if (realScore != null) {
            const scoreA = clamp01((wavePassT - 0.45) * 4) * badgeAge;
            if (scoreA > 0.05) {
              ctx.font      = `500 ${9 * dpr}px 'SF Mono', 'Fira Code', monospace`;
              ctx.textAlign = "left";
              ctx.fillStyle = `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${scoreA * 0.7})`;
              ctx.fillText(realScore.toFixed(3), bx, by + fs + pad);
            }
          }
        }
      }
    }

    // ── Logo at globe center during search ─────────────────
    if (searchActiveRef.current && searchT >= 0 && logoImgRef.current) {
      const logoAlpha = clamp01(searchT * 3) * 0.7;
      if (logoAlpha > 0.01) {
        const logoH = Rdpr * 0.28;
        const logoW = logoH * (logoImgRef.current.naturalWidth / logoImgRef.current.naturalHeight);

        // Soft radial glow behind logo
        const glowStrength = logoAlpha * 0.22;
        const lgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, logoH * 1.5);
        lgGrad.addColorStop(0, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},${glowStrength})`);
        lgGrad.addColorStop(1, `rgba(${GLOW_R},${GLOW_G},${GLOW_B},0)`);
        ctx.beginPath();
        ctx.arc(cx, cy, logoH * 1.5, 0, Math.PI * 2);
        ctx.fillStyle = lgGrad;
        ctx.fill();

        ctx.save();
        ctx.globalAlpha = logoAlpha;
        ctx.drawImage(logoImgRef.current, cx - logoW / 2, cy - logoH / 2, logoW, logoH);
        ctx.restore();
      }
    }

    ctx.restore();
    animRef.current = requestAnimationFrame(draw);
  }, []);

  /* ── Setup ──────────────────────────────────────────────────── */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    initNetwork();

    // Preload logo for canvas rendering
    const img = new (window.Image)();
    img.src = "/logo_ar.svg";
    img.onload = () => { logoImgRef.current = img; };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      dprRef.current = dpr;
      const w = window.innerWidth, h = window.innerHeight;
      sizeRef.current = { w, h };
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };

    resize();
    window.addEventListener("resize", resize);
    prevTRef.current = 0;
    animRef.current = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(animRef.current);
    };
  }, [initNetwork, draw]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
      aria-hidden="true"
    />
  );
});

export default NetworkBackground;
