import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

/**
 * Fixed-position placement for a layer rendered outside its anchor's DOM.
 *
 * A popover inside a list card is clipped by the card: the card hides its overflow for its
 * status rail and skips rendering off-screen (`content-visibility`), and both clip anything
 * that spills past its edge. The layer is therefore portalled to the body and placed here
 * — under the anchor when there is room, above it when there is more room there, and never
 * past the viewport's sides. Re-placed on scroll and resize for as long as it is open.
 */
export function useAnchoredLayer(
  anchor: RefObject<HTMLElement | null>,
  layer: RefObject<HTMLElement | null>,
  open: boolean,
  options: {
    align?: 'start' | 'end';
    side?: 'top' | 'bottom';
    gap?: number;
    matchWidth?: boolean;
    /**
     * Floor for the layer's width when it matches its anchor's.
     *
     * A control sized to its own short text — a language chip in a row — would otherwise
     * open a list too narrow to read the names in. The placement below is told the real
     * width rather than left to discover it from a stylesheet, so the layer still cannot
     * run off the right of the window.
     */
    minWidth?: number;
    maxHeight?: number;
  } = {}
): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const {
    align = 'start',
    side = 'bottom',
    gap = 4,
    matchWidth = false,
    minWidth = 0,
    maxHeight = Infinity
  } = options;
  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    const place = () => {
      const anchorElement = anchor.current;
      const layerElement = layer.current;
      if (!anchorElement || !layerElement) return;
      const rect = anchorElement.getBoundingClientRect();
      const margin = 8;
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const leftEdge = viewportLeft + margin;
      const rightEdge = viewportLeft + viewportWidth - margin;
      // Never reserve more header space than a very short viewport can hold.
      const topEdge = Math.min(
        Math.max(viewportTop, topBarHeight()) + margin,
        viewportTop + viewportHeight - margin
      );
      const bottomEdge = Math.max(topEdge, viewportTop + viewportHeight - margin);
      const availableWidth = Math.max(0, rightEdge - leftEdge);
      const width = Math.min(
        availableWidth,
        Math.max(minWidth, matchWidth ? rect.width : layerElement.offsetWidth)
      );
      // scrollHeight retains the full content height after maxHeight clips the
      // surface. Measuring only offsetHeight made a clipped menu forget its
      // size and flip back below the trigger on the next resize.
      const height = Math.max(layerElement.offsetHeight, layerElement.scrollHeight);
      const below = Math.max(0, bottomEdge - Math.max(topEdge, rect.bottom + gap));
      const above = Math.max(0, Math.min(bottomEdge, rect.top - gap) - topEdge);
      const wanted = Math.min(height, maxHeight);
      const upward =
        side === 'top' ? wanted <= above || above >= below : wanted > below && above > below;
      // On a short window neither side may fit even one complete action.
      // Use the free viewport then, rather than a sliver beside the trigger.
      const useViewport = Math.max(above, below) < Math.min(wanted, 120);
      const shown = Math.max(
        0,
        Math.min(wanted, useViewport ? bottomEdge - topEdge : upward ? above : below)
      );
      const preferredTop = useViewport
        ? topEdge
        : upward
          ? rect.top - gap - shown
          : rect.bottom + gap;
      const top = Math.max(topEdge, Math.min(preferredTop, bottomEdge - shown));
      const preferred = align === 'end' ? rect.right - width : rect.left;
      const left = Math.max(leftEdge, Math.min(preferred, rightEdge - width));
      setStyle({
        position: 'fixed',
        top,
        left,
        right: 'auto',
        bottom: 'auto',
        width: matchWidth ? width : undefined,
        minWidth: Math.min(minWidth, availableWidth),
        maxWidth: availableWidth,
        maxHeight: shown,
        /* Above the dialog stack: what raises an anchored surface is very often
           a dialog — the row menu inside the task editor, the sort menu inside
           the updater — and the pre-024 rung sat below `--layer-modal`, so the
           first menu ever opened from inside a dialog rendered behind it. */
        zIndex: 'var(--layer-anchored)' as unknown as number,
        transformOrigin: `${align === 'end' ? 'right' : 'left'} ${upward ? 'bottom' : 'top'}`
      });
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (anchor.current) observer?.observe(anchor.current);
    if (layer.current) observer?.observe(layer.current);
    const contentObserver = new MutationObserver(place);
    if (layer.current) {
      contentObserver.observe(layer.current, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      observer?.disconnect();
      contentObserver.disconnect();
    };
  }, [open, anchor, layer, align, side, gap, matchWidth, minWidth, maxHeight]);
  return style;
}

function topBarHeight(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--topbar-h');
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 62;
}
