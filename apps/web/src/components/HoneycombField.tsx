import { useEffect, useRef } from 'react';
import { honeycombCells, honeycombGrid, honeycombTraces, honeycombViewBox } from './honeycomb-data';
import { useTheme, type Theme } from '../lib/theme';

const { width: VW, height: VH } = honeycombViewBox;
const POOL_CORNERS = [
  ['0%', '0%'],
  ['100%', '0%'],
  ['0%', '100%'],
  ['100%', '100%']
] as const;

const R = 170; // cursor influence radius (svg units)
const LIFT = 0.075; // max scale-up near the cursor — uniform for every cell
const MAX_GLOW = 7; // px of glow at full lift

// Full-viewport Soty honeycomb backdrop, rendered as real React elements.
// Light/dark colours are driven by CSS on :root[data-theme]. On a theme change
// the tiles flip in a radial wave to reveal the new colour; near the cursor the
// filled cells rise with a theme-tinted glow, and long electric "bug" traces
// crawl the cell walls.
export function HoneycombField() {
  const ref = useRef<SVGSVGElement>(null);
  const { theme } = useTheme();
  const prevTheme = useRef<Theme>(theme);

  // Theme-change transition: the honeycomb field cross-fades. A veil painted
  // with the OLD field colour sits above the scene and fades out, revealing the
  // new-theme honeycomb underneath — same duration/easing as the UI cross-fade
  // (theme.ts arms `.is-theming` at the same instant), so everything lands
  // together.
  useEffect(() => {
    const from = prevTheme.current;
    prevTheme.current = theme;
    if (from === theme) return;
    const svg = ref.current;
    if (!svg) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const baseVeil = svg.querySelector<SVGRectElement>('.hc-base-veil');
    if (!baseVeil) return;
    baseVeil.style.fill = `url(#${from === 'dark' ? 'baseD' : 'baseL'})`;
    const anim = baseVeil.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 775,
      easing: 'cubic-bezier(0.65, 0, 0.35, 1)'
    });
    anim.onfinish = () => {
      baseVeil.style.fill = '';
    };

    return () => {
      anim.cancel();
      baseVeil.style.fill = '';
    };
  }, [theme]);

  // Cursor lift: accent cells near the pointer rise with a theme-tinted glow.
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

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
      const glow = document.documentElement.dataset.theme === 'dark' ? '255 205 105' : '96 52 188';
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
            c.el.style.transform = `scale(${(1 + LIFT * f).toFixed(3)})`;
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
      <svg
        ref={ref}
        className="soty-scene"
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <radialGradient
            id="baseL"
            gradientUnits="userSpaceOnUse"
            cx={VW * 0.5}
            cy={VH * 0.4}
            r={VW * 0.72}
          >
            <stop offset="0%" stopColor="#fdc868" />
            <stop offset="52%" stopColor="#fbb149" />
            <stop offset="100%" stopColor="#f5a233" />
          </radialGradient>
          <radialGradient
            id="baseD"
            gradientUnits="userSpaceOnUse"
            cx={VW * 0.5}
            cy={VH * 0.4}
            r={VW * 0.72}
          >
            <stop offset="0%" stopColor="#2c2058" />
            <stop offset="52%" stopColor="#1e1545" />
            <stop offset="100%" stopColor="#140d2b" />
          </radialGradient>
          <linearGradient id="brightL" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffeaa0" />
            <stop offset="100%" stopColor="#fccf6a" />
          </linearGradient>
          <linearGradient id="brightD" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffd75e" />
            <stop offset="100%" stopColor="#f5a61e" />
          </linearGradient>
          <linearGradient id="fillA" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffdc86" />
            <stop offset="100%" stopColor="#f8b84f" />
          </linearGradient>
          <linearGradient id="fillB" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f7ba55" />
            <stop offset="100%" stopColor="#eea038" />
          </linearGradient>
          <linearGradient id="raise" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3c2e76" />
            <stop offset="100%" stopColor="#271b52" />
          </linearGradient>
          {POOL_CORNERS.map(([cx, cy], i) => (
            <radialGradient key={i} id={`pool${i}`} cx={cx} cy={cy} r="62%">
              <stop offset="0%" stopColor="#f5a623" stopOpacity="0.16" />
              <stop offset="55%" stopColor="#f5a623" stopOpacity="0" />
            </radialGradient>
          ))}
        </defs>
        <rect className="hc-base" width={VW} height={VH} />
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
        {/* Old-field veil (sits above the scene) — fades out on a theme change */}
        <rect className="hc-base-veil" width={VW} height={VH} />
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
