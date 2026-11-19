import { OVERLAY_OPEN_EVENT, tooltipAnchorAllowed } from '../lib/overlayTips';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Hover hints for icon-only controls.
 *
 * A CSS ::after bubble gets clipped by any scrolling ancestor, and a native
 * `title` is drawn by the OS in its own type. So one listener watches for
 * `[data-tip]` under the pointer and renders the bubble into a body portal —
 * never cropped by a panel's overflow, and in the product's own small label.
 *
 * It used to be instant, and with a hint on almost everything the page
 * flickered with labels as the pointer crossed it (058, owner: "they are
 * plainly annoying"). Now a hint waits `TIP_DELAY_MS` on a still pointer;
 * once one is up, the next control answers at once, so reading along a
 * toolbar is not a string of waits. And a hint that only repeats what the
 * control already says in full is not shown at all.
 */
export const TIP_DELAY_MS = 450;
/** After a hint closes, how long its neighbours still answer without the wait. */
export const TIP_WARM_MS = 400;

function sameWords(a: string, b: string): boolean {
  const plain = (value: string) => value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
  return plain(a) === plain(b);
}

/** Whether any text inside `host` is cut off by its box. */
function truncated(host: HTMLElement): boolean {
  if (host.scrollWidth > host.clientWidth + 1 || host.scrollHeight > host.clientHeight + 1)
    return true;
  for (const node of host.querySelectorAll<HTMLElement>('*')) {
    if (node.scrollWidth > node.clientWidth + 1) return true;
  }
  return false;
}

/**
 * A hint that says what is already on the control, word for word, adds
 * nothing — unless those words are cut off, which is the one case such a
 * `title` is there for.
 */
export function redundantTip(host: HTMLElement, text: string): boolean {
  const visible = host.textContent ?? '';
  if (!visible.trim() || !sameWords(visible, text)) return false;
  return !truncated(host);
}
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
    let activeHost: HTMLElement | null = null;
    let activeText = '';
    let pending: ReturnType<typeof setTimeout> | null = null;
    let pendingHost: HTMLElement | null = null;
    let shownUntil = 0;
    let showing = false;
    const allowed = tooltipAnchorAllowed;
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
      if (!(target instanceof HTMLElement) || !allowed(target)) {
        clear();
        return;
      }
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
      if (!(host instanceof HTMLElement)) {
        clear();
        return;
      }
      // Names already readable in full need no duplicate bubble. Measure on
      // each hover so resizing or newly revealed actions cannot leave stale hints.
      if (host.hasAttribute('data-tip-overflow') && host.scrollWidth <= host.clientWidth) {
        clear();
        return;
      }
      const text = host.getAttribute('data-tip');
      if (!text || redundantTip(host, text)) {
        clear();
        return;
      }
      // Still over the same control: the hint is up, or its wait is running.
      if (host === activeHost || host === pendingHost) return;
      const show = () => {
        pending = null;
        pendingHost = null;
        if (!host.isConnected || !allowed(host)) return;
        activeHost = host;
        activeText = host.getAttribute('data-tip') ?? text;
        showing = true;
        place(host, activeText);
      };
      if (pending) clearTimeout(pending);
      if (showing || Date.now() < shownUntil) {
        show();
        return;
      }
      pendingHost = host;
      pending = setTimeout(show, TIP_DELAY_MS);
    };
    const onOut = (event: MouseEvent) => {
      const host = (event.target as HTMLElement | null)?.closest?.('[data-tip]');
      if (!host) return;
      // Moving between the parts of one control is not leaving it.
      const next = event.relatedTarget;
      if (next instanceof Node && host.contains(next)) return;
      clear();
    };
    const clear = () => {
      if (pending) clearTimeout(pending);
      pending = null;
      pendingHost = null;
      if (showing) shownUntil = Date.now() + TIP_WARM_MS;
      showing = false;
      activeHost = null;
      activeText = '';
      setTip(null);
    };
    // Opening a modal via keyboard can leave the pointer and its old tip
    // stationary. Clear it as soon as that anchor becomes background content.
    const observer = new MutationObserver(() => {
      if (!activeHost) return;
      const text = activeHost.getAttribute('data-tip');
      if (!allowed(activeHost) || !text) clear();
      else if (text !== activeText) {
        activeText = text;
        place(activeHost, text);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'aria-hidden', 'role', 'data-tip']
    });
    window.addEventListener(OVERLAY_OPEN_EVENT, clear);
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('pointerdown', clear);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('resize', clear);
    return () => {
      if (pending) clearTimeout(pending);
      observer.disconnect();
      window.removeEventListener(OVERLAY_OPEN_EVENT, clear);
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
