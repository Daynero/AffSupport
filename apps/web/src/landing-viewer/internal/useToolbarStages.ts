import { useCallback, useRef, type RefCallback } from 'react';

const STAGE_CLASSES = ['is-compact', 'is-compact-2', 'is-compact-3', 'is-compact-4'] as const;

/**
 * How much the toolbar has to give up to fit, asked of the layout rather than guessed from
 * the window width.
 *
 * The same measurement as the compressor's `useCompactToolbar`, with four steps instead of
 * two: words go first (`.is-compact`), then the file identity (`.is-compact-2`), then the fit
 * buttons and the zoom stepper (`.is-compact-3`), and on a phone the folder name, the view
 * toggle and the full-screen button (`.is-compact-4`) — everything past the words lives in
 * the "more" menu too, so nothing is lost. Each step is tried with the previous ones applied and measured again,
 * and a window that grows undoes them in reverse. The classes are toggled on the row itself
 * so a re-render never fights the measurement.
 */
export function useToolbarStages(): { ref: RefCallback<HTMLElement> } {
  const detach = useRef<(() => void) | null>(null);
  const ref = useCallback<RefCallback<HTMLElement>>(row => {
    detach.current?.();
    detach.current = null;
    if (!row) return;
    /**
     * How wide the row wants to be.
     *
     * The groups sit in `1fr` tracks and always fill them, so their own widths say nothing;
     * what is summed is their contents. A control keeps its natural width. The one flexible
     * child — the file identity, marked `data-flexible` — ellipsizes rather than overflow, so
     * it is asked for the width of its text, capped at what a name reasonably needs.
     */
    const FLEXIBLE_MAX = 140;
    const wanted = (group: HTMLElement) => {
      const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0;
      const children = Array.from(group.children) as HTMLElement[];
      let visible = 0;
      const total = children.reduce((sum, child) => {
        const width = child.hasAttribute('data-flexible')
          ? Math.min(
              FLEXIBLE_MAX,
              Math.max(
                0,
                ...Array.from(child.children, inner => (inner as HTMLElement).scrollWidth)
              )
            )
          : child.getBoundingClientRect().width;
        if (width > 0) visible += 1;
        return sum + width;
      }, 0);
      return total + gap * Math.max(0, visible - 1);
    };
    const required = () => {
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      // A group the stylesheet hides (the page counter on a phone) takes no gap either.
      const groups = (Array.from(row.children) as HTMLElement[]).filter(
        group => getComputedStyle(group).display !== 'none'
      );
      return (
        groups.reduce((total, group) => total + wanted(group), 0) +
        gap * Math.max(0, groups.length - 1)
      );
    };
    // What the contents may use: the row's box less its own padding.
    const available = () => {
      const style = getComputedStyle(row);
      return (
        row.clientWidth -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0)
      );
    };
    let measuring = false;
    let scheduled: number | null = null;
    const measureNow = () => {
      if (measuring) return;
      measuring = true;
      // Classes only, no React state: the row re-measures on every text change the tree
      // pushes, and a state write here re-rendered the whole viewer for a value nothing read.
      row.classList.remove(...STAGE_CLASSES);
      const room = available();
      let next = 0;
      while (next < STAGE_CLASSES.length && required() > room) {
        row.classList.add(STAGE_CLASSES[next]);
        next += 1;
      }
      queueMicrotask(() => {
        measuring = false;
      });
    };
    const measure = () => {
      if (scheduled !== null) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = null;
        measureNow();
      });
    };
    measureNow();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resize?.observe(row);
    const contents = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure);
    contents?.observe(row, { childList: true, subtree: true });
    window.addEventListener('resize', measure);
    // The first measurement may have used the fallback face; the real one is wider.
    void document.fonts?.ready.then(measure);
    detach.current = () => {
      if (scheduled !== null) cancelAnimationFrame(scheduled);
      resize?.disconnect();
      contents?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return { ref };
}
