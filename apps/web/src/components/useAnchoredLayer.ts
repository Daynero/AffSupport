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
      const width = Math.max(minWidth, matchWidth ? rect.width : layerElement.offsetWidth);
      const height = layerElement.offsetHeight;
      const margin = 8;
      // The app's fixed top bar is not free space; a layer never opens over it.
      const topEdge = topBarHeight() + margin;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const below = viewportHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - topEdge;
      const wanted = Math.min(height, maxHeight);
      const upward = wanted > below && above > below;
      const shown = Math.min(wanted, Math.max(120, upward ? above : below));
      const top = upward
        ? Math.max(topEdge, rect.top - gap - shown)
        : Math.min(Math.max(topEdge, viewportHeight - margin - shown), rect.bottom + gap);
      const preferred = align === 'end' ? rect.right - width : rect.left;
      const left = Math.max(margin, Math.min(preferred, viewportWidth - margin - width));
      setStyle({
        position: 'fixed',
        top,
        left,
        width: matchWidth ? width : undefined,
        maxHeight: shown,
        zIndex: 'var(--layer-popover)' as unknown as number,
        transformOrigin: `${align === 'end' ? 'right' : 'left'} ${upward ? 'bottom' : 'top'}`
      });
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, layer, align, gap, matchWidth, minWidth, maxHeight]);
  return style;
}

function topBarHeight(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--topbar-h');
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 62;
}
