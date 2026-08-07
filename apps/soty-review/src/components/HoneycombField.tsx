import { useEffect, useRef } from 'react';
import { honeycombCells, honeycombGrid, honeycombTraces, honeycombViewBox } from './honeycomb-data';
import type { CellTier } from './honeycomb-data';
import type { Theme } from '../review/model';

const { width: VW, height: VH } = honeycombViewBox;

// gradient id a cell uses for a given theme
const cellFill = (t: Theme, tier: CellTier) => {
  if (tier === 'field') return t === 'dark' ? 'baseD' : 'baseL';
  if (t === 'dark') return tier === 'bright' ? 'brightD' : 'raise';
  return tier === 'bright' ? 'brightL' : tier === 'a' ? 'fillA' : 'fillB';
};
const POOL_CORNERS = [
  ['0%', '0%'],
  ['100%', '0%'],
  ['0%', '100%'],
  ['100%', '100%']
] as const;

const R = 170; // influence radius (svg units)
const LIFT = 0.075; // max scale-up near the cursor — uniform for every cell
const MAX_GLOW = 7; // px of glow at full lift

// Full-viewport honeycomb backdrop. Filled cells near the cursor rise toward the
// viewer in 3D (translateZ under a per-cell perspective) — a soft dome that
// follows the pointer. Cells keep their position and shape (a per-cell *tilt*
// would break the shared walls into fun-house distortion; a lift does not).
// Rendered as real React elements so the DOM stays stable; light/dark is pure CSS.
export function HoneycombField({ theme }: { theme: Theme }) {
  const ref = useRef<SVGSVGElement>(null);
  const prevTheme = useRef<Theme>(theme);
  const themeRef = useRef<Theme>(theme);
  themeRef.current = theme; // kept current for the (mount-once) cursor-lift effect

  // Theme-switch transition: cells flip through their centre in a top-to-bottom
  // wave; each cell swaps to the new colour edge-on (at 90°), so the "other side"
  // is the new theme. The base wipes to the new colour top-to-bottom in sync.
  useEffect(() => {
    const from = prevTheme.current;
    prevTheme.current = theme;
    if (from === theme) return;
    const svg = ref.current;
    if (!svg) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const cells = Array.from(svg.querySelectorAll<SVGPathElement>('.soty-cell'));
    const baseVeil = svg.querySelector<SVGRectElement>('.hc-base-veil');
    // Radial wave: distance of each cell from the centre drives its delay.
    const CX = VW / 2;
    const CY = VH / 2;
    const dist = (el: SVGPathElement) =>
      Math.hypot(Number(el.dataset.cx) - CX, Number(el.dataset.cy) - CY);
    const maxDist = Math.max(...cells.map(dist)) || 1;
    const FLIP = 300;
    const WAVE = 430;
    const timers: number[] = [];
    const anims: Animation[] = [];
    const tierOf = (el: Element): CellTier =>
      el.classList.contains('t-bright') ? 'bright' : el.classList.contains('t-a') ? 'a' : 'b';

    // While the tiles flip, cross-fade every non-tile panel (topbar, cards,
    // buttons, text) to the new theme instead of snapping.
    const root = svg.closest('.soty-review');
    if (root) {
      root.classList.add('is-theming');
      timers.push(window.setTimeout(() => root.classList.remove('is-theming'), WAVE + FLIP + 80));
    }

    // The field behind the cells keeps the OLD colour and cross-fades to the new
    // one, so a flipping cell never reveals a gap — behind it is the same field.
    if (baseVeil) {
      // opacity-only (no display toggle) — avoids a full-screen layout/repaint
      // flash when the animation ends.
      baseVeil.style.fill = `url(#${from === 'dark' ? 'baseD' : 'baseL'})`;
      const a = baseVeil.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: WAVE + FLIP,
        easing: 'ease-out'
      });
      anims.push(a);
      a.onfinish = () => {
        baseVeil.style.fill = '';
      };
    }

    for (const el of cells) {
      const dx = Number(el.dataset.cx) - CX;
      const dy = Number(el.dataset.cy) - CY;
      const l = Math.hypot(dx, dy) || 1;
      const delay = (l / maxDist) * WAVE;
      // Flip axis is the tangent to the circle centred on the screen — the tile
      // narrows along its radius (a ripple from the centre). It folds to an
      // edge-on line at 90° (colour swaps there) then unfolds to the SAME
      // orientation — never reaching 180°, so it never looks rotated/mirrored.
      const ax = (-dy / l).toFixed(3);
      const ay = (dx / l).toFixed(3);
      const tier = tierOf(el);
      el.style.fill = `url(#${cellFill(from, tier)})`;
      anims.push(
        el.animate(
          [
            { transform: `rotate3d(${ax}, ${ay}, 0, 0deg)` },
            { transform: `rotate3d(${ax}, ${ay}, 0, 90deg)`, offset: 0.5 },
            { transform: `rotate3d(${ax}, ${ay}, 0, 0deg)` }
          ],
          { duration: FLIP, delay, easing: 'ease-in-out' }
        )
      );
      timers.push(
        window.setTimeout(() => {
          el.style.fill = `url(#${cellFill(theme, tier)})`;
        }, delay + FLIP / 2),
        window.setTimeout(() => {
          el.style.fill = '';
        }, delay + FLIP + 30)
      );
    }

    return () => {
      timers.forEach(clearTimeout);
      anims.forEach(a => a.cancel());
      cells.forEach(el => {
        el.style.fill = '';
      });
      if (baseVeil) baseVeil.style.fill = '';
      root?.classList.remove('is-theming');
    };
  }, [theme]);

  // Cursor lift: cells near the pointer rise toward the viewer with a warm glow.
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    // Only the coloured accent tiles react to the cursor — field tiles are
    // transparent at rest, so lifting them would be invisible work.
    const cells = Array.from(svg.querySelectorAll<SVGPathElement>('.soty-cell:not(.t-field)')).map(
      el => ({ el, cx: Number(el.dataset.cx), cy: Number(el.dataset.cy) })
    );

    const B = 160;
    const buckets = new Map<string, number[]>();
    cells.forEach((c, i) => {
      const k = `${Math.floor(c.cx / B)},${Math.floor(c.cy / B)}`;
      const arr = buckets.get(k);
      if (arr) arr.push(i);
      else buckets.set(k, [i]);
    });

    const R2 = R * R;
    let active = new Set<number>();
    let raf = 0;
    let mx = 0;
    let my = 0;
    // Cache the screen→SVG matrix (only changes on resize) so mousemove doesn't
    // force a layout every frame.
    let inv = svg.getScreenCTM()?.inverse() ?? null;
    const refreshCtm = () => {
      inv = svg.getScreenCTM()?.inverse() ?? null;
    };

    const process = () => {
      raf = 0;
      if (!inv) {
        refreshCtm();
        if (!inv) return;
      }
      const pt = new DOMPoint(mx, my).matrixTransform(inv);
      const glow = themeRef.current === 'dark' ? '255 205 105' : '96 52 188';
      const cbx = Math.floor(pt.x / B);
      const cby = Math.floor(pt.y / B);
      const next = new Set<number>();
      for (let gx = cbx - 1; gx <= cbx + 1; gx++) {
        for (let gy = cby - 1; gy <= cby + 1; gy++) {
          const arr = buckets.get(`${gx},${gy}`);
          if (!arr) continue;
          for (const i of arr) {
            const c = cells[i];
            const dx = pt.x - c.cx;
            const dy = pt.y - c.cy;
            const d2 = dx * dx + dy * dy;
            if (d2 > R2) continue;
            const f = Math.pow(1 - Math.sqrt(d2) / R, 1.5);
            // uniform scale-up about the cell's own centre — same for every cell
            // regardless of screen position (no perspective-origin skew)
            c.el.style.transform = `scale(${(1 + LIFT * f).toFixed(3)})`;
            // glow grows with the lift — warm honey on dark, purple on light
            c.el.style.filter = `drop-shadow(0 0 ${(MAX_GLOW * f).toFixed(1)}px rgb(${glow} / ${(0.6 * f).toFixed(2)}))`;
            next.add(i);
          }
        }
      }
      for (const i of active)
        if (!next.has(i)) {
          cells[i].el.style.transform = '';
          cells[i].el.style.filter = '';
        }
      active = next;
    };

    const onMove = (e: MouseEvent) => {
      mx = e.clientX;
      my = e.clientY;
      if (!raf) raf = requestAnimationFrame(process);
    };
    const reset = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      for (const i of active) {
        cells[i].el.style.transform = '';
        cells[i].el.style.filter = '';
      }
      active = new Set();
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('resize', refreshCtm);
    document.addEventListener('mouseleave', reset);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('resize', refreshCtm);
      document.removeEventListener('mouseleave', reset);
      if (raf) cancelAnimationFrame(raf);
      for (const c of cells) {
        c.el.style.transform = '';
        c.el.style.filter = '';
      }
    };
  }, []);

  return (
    <div className="soty-honeycomb" aria-hidden="true">
      <svg ref={ref} className="soty-scene" viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <radialGradient id="baseL" gradientUnits="userSpaceOnUse" cx={VW * 0.5} cy={VH * 0.4} r={VW * 0.72}>
            <stop offset="0%" stopColor="#FDC868" />
            <stop offset="52%" stopColor="#FBB149" />
            <stop offset="100%" stopColor="#F5A233" />
          </radialGradient>
          <radialGradient id="baseD" gradientUnits="userSpaceOnUse" cx={VW * 0.5} cy={VH * 0.4} r={VW * 0.72}>
            <stop offset="0%" stopColor="#2C2058" />
            <stop offset="52%" stopColor="#1E1545" />
            <stop offset="100%" stopColor="#140D2B" />
          </radialGradient>
          <linearGradient id="brightL" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFEAA0" />
            <stop offset="100%" stopColor="#FCCF6A" />
          </linearGradient>
          <linearGradient id="brightD" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFD75E" />
            <stop offset="100%" stopColor="#F5A61E" />
          </linearGradient>
          <linearGradient id="fillA" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFDC86" />
            <stop offset="100%" stopColor="#F8B84F" />
          </linearGradient>
          <linearGradient id="fillB" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#F7BA55" />
            <stop offset="100%" stopColor="#EEA038" />
          </linearGradient>
          <linearGradient id="raise" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3C2E76" />
            <stop offset="100%" stopColor="#271B52" />
          </linearGradient>
          {POOL_CORNERS.map(([cx, cy], i) => (
            <radialGradient key={i} id={`pool${i}`} cx={cx} cy={cy} r="62%">
              <stop offset="0%" stopColor="#F5A623" stopOpacity="0.16" />
              <stop offset="55%" stopColor="#F5A623" stopOpacity="0" />
            </radialGradient>
          ))}
        </defs>
        <rect className="hc-base" width={VW} height={VH} />
        <rect className="hc-base-veil" width={VW} height={VH} />
        {POOL_CORNERS.map((_, i) => (
          <rect key={i} className={`hc-pool hc-pool${i}`} width={VW} height={VH} />
        ))}
        <g className="hc-grid" fill="none" strokeWidth={1.2}>
          <path d={honeycombGrid} />
        </g>
        <g className="soty-cells">
          {honeycombCells.map((c, i) => (
            <path
              key={i}
              className={`soty-cell t-${c.tier}${c.tier === 'bright' ? ' is-lit' : ''}`}
              data-cx={c.cx}
              data-cy={c.cy}
              d={c.d}
            />
          ))}
        </g>
      </svg>
      <svg
        className="soty-trace-layer"
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMidYMid slice"
      >
        <g fill="none" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
          {honeycombTraces.map((t, i) => (
            <path
              key={i}
              className={`soty-trace${t.rev ? ' is-rev' : ''}`}
              d={t.d}
              pathLength={100}
              style={{ animationDuration: `${t.dur}s`, animationDelay: `${t.delay}s` }}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}
