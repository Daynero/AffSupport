import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Instant hover hints for icon-only controls.
 *
 * Native `title` waits about a second before the OS shows it, and a CSS
 * ::after bubble gets clipped by any scrolling ancestor. So one listener
 * watches for `[data-tip]` under the pointer and renders the bubble into a
 * body portal — instant, and never cropped by a panel's overflow.
 */
export function InstantTips() {
  const [tip, setTip] = useState<{
    text: string;
    left: number;
    top: number;
    anchorTop: number;
    anchorBottom: number;
  } | null>(null);
  const bubble = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const node = bubble.current;
    if (!node || !tip) return;
    const height = node.offsetHeight;
    const below = tip.anchorBottom + 8;
    const fitsBelow = below + height + 8 <= window.innerHeight;
    const top = fitsBelow ? below : Math.max(8, tip.anchorTop - 8 - height);
    if (Math.abs(top - tip.top) > 1) setTip({ ...tip, top });
  }, [tip]);

  useEffect(() => {
    const place = (host: HTMLElement, text: string) => {
      const rect = host.getBoundingClientRect();
      // Matches the CSS cap, so a long name is centred against the control
      // without pushing the bubble off either edge.
      const width = Math.min(560, window.innerWidth - 32);
      const left = Math.min(
        window.innerWidth - width / 2 - 12,
        Math.max(width / 2 + 12, rect.left + rect.width / 2)
      );
      // Below the control, unless that would fall off the viewport. The bubble
      // is placed once at an estimate and corrected against its measured
      // height the moment it exists, so a six-line hint near the bottom edge
      // flips above its control instead of covering it.
      const below = rect.bottom + 8;
      const top = below + 96 > window.innerHeight ? Math.max(8, rect.top - 96) : below;
      setTip({ text, left, top, anchorTop: rect.top, anchorBottom: rect.bottom });
    };
    const onOver = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      // A native `title` waits about a second for the OS and then draws a tiny
      // system bubble. Anything carrying one is adopted here on first hover:
      // the attribute moves to data-tip (keeping its text as the accessible
      // name when there is none), so every hint on the page is instant and
      // reads at the app's own size.
      const native = target?.closest?.('[title]');
      if (native instanceof HTMLElement) {
        const text = native.getAttribute('title') ?? '';
        if (text) {
          native.setAttribute('data-tip', text);
          if (!native.getAttribute('aria-label') && !native.textContent?.trim()) {
            native.setAttribute('aria-label', text);
          }
        }
        native.removeAttribute('title');
      }
      const host = target?.closest?.('[data-tip]');
      if (!(host instanceof HTMLElement)) return;
      const text = host.getAttribute('data-tip');
      if (!text) return;
      place(host, text);
    };
    const onOut = (event: MouseEvent) => {
      const host = (event.target as HTMLElement | null)?.closest?.('[data-tip]');
      if (host) setTip(null);
    };
    const clear = () => setTip(null);
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('pointerdown', clear);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('resize', clear);
    return () => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('pointerdown', clear);
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
    };
  }, []);

  if (!tip) return null;
  // A hint written as lines (an account, its id, its runs) is a small table
  // and reads as one: kept on its lines and set flush left, where a one-line
  // hint stays centred under its control.
  const multiline = tip.text.includes('\n');
  return createPortal(
    <span
      ref={bubble}
      className={`instant-tip${multiline ? ' is-multiline' : ''}`}
      style={{ left: tip.left, top: tip.top }}
      role="presentation"
    >
      {tip.text}
    </span>,
    document.body
  );
}
