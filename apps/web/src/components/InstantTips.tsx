import { useEffect, useState } from 'react';
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
  const [tip, setTip] = useState<{ text: string; left: number; top: number } | null>(null);

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
      // Below the control, unless that would fall off the viewport.
      const below = rect.bottom + 8;
      const top = below + 96 > window.innerHeight ? Math.max(8, rect.top - 96) : below;
      setTip({ text, left, top });
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
  return createPortal(
    <span className="instant-tip" style={{ left: tip.left, top: tip.top }} role="presentation">
      {tip.text}
    </span>,
    document.body
  );
}
