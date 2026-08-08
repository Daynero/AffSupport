import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Generates the Soty honeycomb geometry as a data module:
//   src/components/honeycomb-data.ts  — grid, recessed, cells, traces, viewBox
// HoneycombField renders this as real React elements (NOT innerHTML), so the DOM
// nodes stay stable across re-renders/theme switches — the cursor-tilt effect and
// the trace animation are never disrupted. Light/dark is driven purely by CSS on
// the `.soty-review[data-soty-theme]` ancestor. Filled cells carry a tier class so
// CSS can colour them and JS can lean them toward the cursor.
// Usage: node scripts/generate-honeycomb-bg.mjs

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260806);

const W = 1920;
const H = 1080;

const r = 34;
const hexW = Math.sqrt(3) * r;
const vert = 1.5 * r;

function verts(cx, cy, rad) {
  const p = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90);
    p.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return p;
}
const fmt = ([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`;
const hexPath = (cx, cy, rad) => 'M' + verts(cx, cy, rad).map(fmt).join('L') + 'Z';

const GN = 10;
const noiseGrid = [];
for (let j = 0; j <= GN; j++) {
  noiseGrid[j] = [];
  for (let i = 0; i <= GN; i++) noiseGrid[j][i] = rnd();
}
function noise(x, y) {
  const gx = Math.max(0, Math.min(GN, (x / W) * GN));
  const gy = Math.max(0, Math.min(GN, (y / H) * GN));
  const x0 = Math.min(GN - 1, Math.floor(gx));
  const y0 = Math.min(GN - 1, Math.floor(gy));
  const tx = gx - x0;
  const ty = gy - y0;
  const a = noiseGrid[y0][x0];
  const b = noiseGrid[y0][x0 + 1];
  const c = noiseGrid[y0 + 1][x0];
  const d = noiseGrid[y0 + 1][x0 + 1];
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}

const band = 340;
const grid = [];
const cells = []; // every hexagon is a cell (tier 'field' unless it's an accent)

const nodes = new Map();
const adj = new Map();
const key = (x, y) => `${Math.round(x)},${Math.round(y)}`;
function addEdge(a, b) {
  const ka = key(a[0], a[1]);
  const kb = key(b[0], b[1]);
  if (ka === kb) return;
  if (!nodes.has(ka)) nodes.set(ka, a);
  if (!nodes.has(kb)) nodes.set(kb, b);
  if (!adj.has(ka)) adj.set(ka, new Set());
  if (!adj.has(kb)) adj.set(kb, new Set());
  adj.get(ka).add(kb);
  adj.get(kb).add(ka);
}

const rows = Math.ceil(H / vert) + 2;
const cols = Math.ceil(W / hexW) + 2;
for (let row = -1; row < rows; row++) {
  const cy = row * vert;
  const xoff = row & 1 ? hexW / 2 : 0;
  for (let col = -1; col < cols; col++) {
    const cx = col * hexW + xoff + hexW / 2;
    const v = verts(cx, cy, r);
    grid.push('M' + v.map(fmt).join('L') + 'Z');
    for (let i = 0; i < 6; i++) addEdge(v[i], v[(i + 1) % 6]);

    const edge = Math.min(cx, W - cx, cy, H - cy);
    let tier = 'field';
    if (edge <= band) {
      const t = 1 - edge / band;
      const clump = noise(cx, cy);
      const p = Math.pow(t, 1.35) * (0.25 + 1.15 * clump);
      const roll = rnd();
      if (roll < p * 0.9) {
        const tone = rnd();
        tier = tone < 0.18 ? 'bright' : tone < 0.85 ? 'a' : 'b';
      }
    }
    cells.push({ d: hexPath(cx, cy, r - 1.5), cx, cy, tier });
  }
}

// Electric traces: directional random walks along the cell walls, with starts
// spread across the whole viewport (min distance apart) so they cover the screen.
const inBounds = [...nodes.keys()].filter(k => {
  const [x, y] = nodes.get(k);
  return x > 70 && x < W - 70 && y > 70 && y < H - 70;
});
function walk(startK) {
  let curK = startK;
  let prev = null;
  let heading = null;
  const pts = [nodes.get(curK)];
  const recent = new Set([curK]); // sliding window — lets long walks wander far
  const recentArr = [curK];
  const steps = 95 + Math.floor(rnd() * 85); // very long conduits
  for (let i = 0; i < steps; i++) {
    const neigh = [...adj.get(curK)].filter(k => k !== prev && !recent.has(k));
    if (!neigh.length) break;
    let nextK;
    if (heading) {
      let best = null;
      let bestScore = -Infinity;
      const [cx, cy] = nodes.get(curK);
      for (const k of neigh) {
        const [nx, ny] = nodes.get(k);
        const vx = nx - cx;
        const vy = ny - cy;
        const len = Math.hypot(vx, vy) || 1;
        const score = (vx / len) * heading[0] + (vy / len) * heading[1] + rnd() * 0.6;
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      }
      nextK = best;
    } else {
      nextK = neigh[Math.floor(rnd() * neigh.length)];
    }
    const [cx, cy] = nodes.get(curK);
    const [nx, ny] = nodes.get(nextK);
    const len = Math.hypot(nx - cx, ny - cy) || 1;
    heading = [(nx - cx) / len, (ny - cy) / len];
    pts.push([nx, ny]);
    recent.add(nextK);
    recentArr.push(nextK);
    if (recentArr.length > 16) recent.delete(recentArr.shift());
    prev = curK;
    curK = nextK;
  }
  return pts;
}
// One long "bug" spawns per evenly-spaced region of the screen; direction and
// lifetime (full crawl over the trace) are random, 5–12s.
const N = 4;
const gCols = Math.ceil(Math.sqrt(N));
const gRows = Math.ceil(N / gCols);
const traces = [];
for (let ry = 0; ry < gRows && traces.length < N; ry++) {
  for (let rx = 0; rx < gCols && traces.length < N; rx++) {
    const tx = ((rx + 0.5) / gCols) * W;
    const ty = ((ry + 0.5) / gRows) * H;
    let bestPts = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      const cand = inBounds[Math.floor(rnd() * inBounds.length)];
      const [cx, cy] = nodes.get(cand);
      if (Math.hypot(cx - tx, cy - ty) > 280) continue; // stay within this region
      const pts = walk(cand);
      if (pts.length >= 40) {
        bestPts = pts;
        break;
      }
      if (!bestPts || pts.length > bestPts.length) bestPts = pts;
    }
    if (!bestPts) continue;
    const dur = 5 + rnd() * 7; // lifetime 5–12s
    traces.push({
      d: 'M' + bestPts.map(fmt).join('L'),
      dur: Number(dur.toFixed(2)),
      delay: Number((-rnd() * dur).toFixed(2)), // random phase, always mid-crawl
      rev: rnd() < 0.5 // random direction
    });
  }
}

const gridD = grid.join('');
const cellData = cells.map(c => ({
  d: c.d,
  cx: Math.round(c.cx),
  cy: Math.round(c.cy),
  tier: c.tier
}));

const dataTs = `// Auto-generated by scripts/generate-honeycomb-bg.mjs — do not edit.
export type CellTier = 'bright' | 'a' | 'b' | 'field';
export type HoneycombCell = { d: string; cx: number; cy: number; tier: CellTier };
export type HoneycombTrace = { d: string; dur: number; delay: number; rev: boolean };

export const honeycombViewBox = { width: ${W}, height: ${H} };
export const honeycombGrid = ${JSON.stringify(gridD)};
export const honeycombCells: HoneycombCell[] = ${JSON.stringify(cellData)};
export const honeycombTraces: HoneycombTrace[] = ${JSON.stringify(traces)};
`;
writeFileSync(
  fileURLToPath(new URL('../src/components/honeycomb-data.ts', import.meta.url)),
  dataTs
);

console.log('wrote honeycomb-data.ts —', 'cells:', cells.length, 'traces:', traces.length);
