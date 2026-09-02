/**
 * The batch toolbar's collapse, shared by every tool that has one.
 *
 * When the row runs out of room the action buttons drop their words and keep their icons;
 * when it is narrower still, the counters lose theirs too. Written once here because the
 * compressor and the stitcher render the same toolbar, and a second copy of this measurement
 * would be a second chance for the two to disagree about when a window is too narrow.
 */

import { useLayoutEffect, useRef, useState } from 'react';

export interface CompactToolbar {
  ref: React.RefObject<HTMLDivElement | null>;
  compactActions: boolean;
  compactChips: boolean;
}

export function useCompactToolbar(): CompactToolbar {
  const ref = useRef<HTMLDivElement>(null);
  const [compactActions, setCompactActions] = useState(false);
  const [compactChips, setCompactChips] = useState(false);

  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    /**
     * How wide the row wants to be, asked of the layout rather than guessed.
     *
     * The chips container shrinks (and hides its overflow) instead of pushing the row wider,
     * so comparing scrollWidth with clientWidth on the row itself always reported "fits" and
     * the collapsed state could never lift. Summing what each group actually needs is the
     * honest question.
     */
    const required = () => {
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      const children = Array.from(row.children) as HTMLElement[];
      return (
        children.reduce((total, child) => total + child.scrollWidth, 0) +
        gap * Math.max(0, children.length - 1)
      );
    };
    const measure = () => {
      const available = row.clientWidth;
      // Measured with the words back on, so a window that grew can undo a collapse instead
      // of staying compact forever.
      row.classList.remove('is-compact', 'is-compact-chips');
      const needsActions = required() > available;
      let needsChips = false;
      if (needsActions) {
        row.classList.add('is-compact');
        needsChips = required() > available;
      }
      row.classList.toggle('is-compact', needsActions);
      row.classList.toggle('is-compact-chips', needsChips);
      setCompactActions(needsActions);
      setCompactChips(needsChips);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  });

  return { ref, compactActions, compactChips };
}
