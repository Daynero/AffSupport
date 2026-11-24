import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OVERLAY_OPEN_EVENT, tooltipAnchorAllowed } from '../../lib/overlayTips';
import { HINT_DELAY_MS, hintWarm, noteHint } from './Feedback';

/**
 * The hint behind every `title` (070, T033, T034).
 *
 * Two kinds of thing in this product carry a hint. A control that is built
 * around one takes the inventory's `Tooltip`, which is React Aria's and needs a
 * focusable trigger. Everything else says its hint the way HTML always has — a
 * `title`: an icon button's name (the inventory's `IconButton` sets one from its
 * label), a cut-off file name, a path shortened to its last folders. About five
 * hundred of those exist, most of them on text nothing can focus.
 *
 * A native `title` waits about a second for the operating system and is then
 * drawn in its type, at its size. So this one listener adopts a `title` on the
 * first hover — the words move to `data-hint`, keeping them as the accessible
 * name where the element has none, and later writes of that `title` follow
 * them there — and draws the inventory's own small dark
 * label (`.ui-tooltip`), portalled to the body so no scrolling panel crops it.
 * It waits the inventory's one delay and shares the inventory's warm-up: once
 * any hint is up, the next answers at once, whichever kind it is.
 *
 * It replaces `InstantTips` and its `data-tip` attribute. No screen writes
 * `data-hint`; it is this layer's own bookkeeping.
 *
 * A hint that only repeats what its element already shows in full is not drawn
 * — unless those words are cut off, which is the one case such a `title` is
 * there for.
 */

const ATTRIBUTE = 'data-hint';

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

/** A hint that says, word for word, what is already readable in full. */
export function redundantHint(host: HTMLElement, text: string): boolean {
  const visible = host.textContent ?? '';
  if (!visible.trim() || !sameWords(visible, text)) return false;
  return !truncated(host);
}

const taken = new WeakSet<HTMLElement>();

/**
 * Moves a native `title` onto the layer, so the operating system never draws it.
 *
 * The element is taken over for good: React keeps writing its `title` as the
 * screen's state changes — a progress row's hint goes when the work ends — and
 * those writes now land on `data-hint`. Without that, a `title` React removed
 * after the layer had already removed it was a no-op, and the hint outlived
 * the state it described.
 */
function adopt(target: HTMLElement): void {
  const native = target.closest?.('[title]');
  if (!(native instanceof HTMLElement)) return;
  const text = native.getAttribute('title') ?? '';
  Element.prototype.removeAttribute.call(native, 'title');
  if (!taken.has(native)) {
    taken.add(native);
    native.setAttribute = (name: string, value: string) => {
      if (name !== 'title') return Element.prototype.setAttribute.call(native, name, value);
      if (value) Element.prototype.setAttribute.call(native, ATTRIBUTE, value);
      // `title=""` is how a control says it wants no hint (docs/DESIGN.md).
      else Element.prototype.removeAttribute.call(native, ATTRIBUTE);
    };
    native.removeAttribute = (name: string) =>
      Element.prototype.removeAttribute.call(native, name === 'title' ? ATTRIBUTE : name);
  }
  native.setAttribute('title', text);
  if (text && !native.getAttribute('aria-label') && !native.textContent?.trim()) {
    native.setAttribute('aria-label', text);
  }
}

interface Placed {
  text: string;
  left: number;
  top: number;
  anchorTop: number;
  anchorBottom: number;
}

export function HintLayer() {
  const [hint, setHint] = useState<Placed | null>(null);
  const bubble = useRef<HTMLSpanElement>(null);

  // Placed once at an estimate and corrected against the measured height the
  // moment it exists, so a six-line hint near the bottom edge flips above its
  // element instead of covering it.
  useLayoutEffect(() => {
    const node = bubble.current;
    if (!node || !hint) return;
    const height = node.offsetHeight;
    const below = hint.anchorBottom + 8;
    const top =
      below + height + 8 <= window.innerHeight ? below : Math.max(8, hint.anchorTop - 8 - height);
    if (Math.abs(top - hint.top) > 1) setHint({ ...hint, top });
  }, [hint]);

  useEffect(() => {
    let activeHost: HTMLElement | null = null;
    let activeText = '';
    let pending: ReturnType<typeof setTimeout> | null = null;
    let pendingHost: HTMLElement | null = null;
    const place = (host: HTMLElement, text: string) => {
      const rect = host.getBoundingClientRect();
      // Matches the stylesheet's cap, so a long name is centred against its
      // element without pushing the bubble off either edge.
      const width = Math.min(560, window.innerWidth - 32);
      const left = Math.min(
        window.innerWidth - width / 2 - 12,
        Math.max(width / 2 + 12, rect.left + rect.width / 2)
      );
      const below = rect.bottom + 8;
      const top = below + 96 > window.innerHeight ? Math.max(8, rect.top - 96) : below;
      setHint({ text, left, top, anchorTop: rect.top, anchorBottom: rect.bottom });
    };
    const clear = () => {
      if (pending) clearTimeout(pending);
      pending = null;
      pendingHost = null;
      if (activeHost) noteHint(false);
      activeHost = null;
      activeText = '';
      setHint(null);
    };
    const onOver = (event: MouseEvent) => {
      // The pointer is usually on the icon inside a button, which is an SVG
      // element, not an HTML one. Taking only HTML targets — as `InstantTips`
      // did — meant an icon button's hint came up only over its padding.
      const target = event.target;
      if (!(target instanceof Element)) {
        clear();
        return;
      }
      const html = target instanceof HTMLElement ? target : target.parentElement;
      if (!html || !tooltipAnchorAllowed(html)) {
        clear();
        return;
      }
      adopt(html);
      const host = html.closest(`[${ATTRIBUTE}]`);
      if (!(host instanceof HTMLElement)) {
        clear();
        return;
      }
      const text = host.getAttribute(ATTRIBUTE);
      if (!text || redundantHint(host, text)) {
        clear();
        return;
      }
      // Still over the same element: the hint is up, or its wait is running.
      if (host === activeHost || host === pendingHost) return;
      const show = () => {
        pending = null;
        pendingHost = null;
        if (!host.isConnected || !tooltipAnchorAllowed(host)) return;
        activeHost = host;
        activeText = host.getAttribute(ATTRIBUTE) ?? text;
        noteHint(true);
        place(host, activeText);
      };
      if (pending) clearTimeout(pending);
      if (hintWarm()) {
        show();
        return;
      }
      pendingHost = host;
      pending = setTimeout(show, HINT_DELAY_MS);
    };
    const onOut = (event: MouseEvent) => {
      const target = event.target;
      const host = target instanceof Element ? target.closest(`[${ATTRIBUTE}]`) : null;
      if (!host) return;
      // Moving between the parts of one element is not leaving it.
      const next = event.relatedTarget;
      if (next instanceof Node && host.contains(next)) return;
      clear();
    };
    // A dialog opened from the keyboard can leave the pointer, and its hint,
    // where they were. The hint goes as soon as its element is background.
    const observer = new MutationObserver(() => {
      if (!activeHost) return;
      const text = activeHost.getAttribute(ATTRIBUTE);
      if (!tooltipAnchorAllowed(activeHost) || !text) clear();
      else if (text !== activeText) {
        activeText = text;
        place(activeHost, text);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'aria-hidden', 'role', ATTRIBUTE]
    });
    window.addEventListener(OVERLAY_OPEN_EVENT, clear);
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('pointerdown', clear);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('resize', clear);
    return () => {
      if (pending) clearTimeout(pending);
      // A layer that goes while its hint is up must not leave the group warm.
      if (activeHost) noteHint(false);
      observer.disconnect();
      window.removeEventListener(OVERLAY_OPEN_EVENT, clear);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('pointerdown', clear);
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
    };
  }, []);

  if (!hint) return null;
  // A hint written as lines (an account, its id, its runs) is a small table and
  // reads as one: kept on its lines and set flush left.
  const multiline = hint.text.includes('\n');
  return createPortal(
    <span
      ref={bubble}
      className={`ui-tooltip ui-hint${multiline ? ' is-multiline' : ''}`}
      style={{ left: hint.left, top: hint.top }}
      role="presentation"
    >
      {hint.text}
    </span>,
    document.body
  );
}
