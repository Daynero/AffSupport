/**
 * The batch toolbar's collapse, shared by every tool that has one.
 *
 * When the row runs out of room the action buttons drop their words and keep their icons;
 * when it is narrower still, the counters lose theirs too. Written once here because the
 * compressor and the stitcher render the same toolbar, and a second copy of this measurement
 * would be a second chance for the two to disagree about when a window is too narrow.
 */

import { useCallback, useRef, useState, type RefCallback } from 'react';

export interface CompactToolbar {
  /** Attach to the toolbar row. A callback, so a row that mounts later is still measured. */
  ref: RefCallback<HTMLDivElement>;
  compactActions: boolean;
  compactChips: boolean;
  /** The selection group has lost its words too; set on the group's own element. */
  compactSelection: boolean;
}

export function useCompactToolbar(): CompactToolbar {
  const [compactActions, setCompactActions] = useState(false);
  const [compactChips, setCompactChips] = useState(false);
  const [compactSelection, setCompactSelection] = useState(false);
  const detach = useRef<(() => void) | null>(null);

  // A callback ref rather than an effect over a ref object: the row is rendered only once
  // there are jobs, so an effect that ran on mount found nothing to observe and never ran
  // again. The observers attach the moment the row exists and go with it.
  const ref = useCallback<RefCallback<HTMLDivElement>>(row => {
    detach.current?.();
    detach.current = null;
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
    let measuring = false;
    let scheduled: number | null = null;
    const measureNow = () => {
      // The measurement toggles classes, which the mutation observer would report as a
      // change of contents; it is not one.
      if (measuring) return;
      measuring = true;
      const available = row.clientWidth;
      // Measured with the words back on, so a window that grew can undo a collapse instead
      // of staying compact forever.
      // The third stage is toggled on the selection group itself rather than the row: the
      // consumers render that element with a constant class, so a re-render never rewrites
      // what is set here, and no page has to know the stage exists.
      const selection = row.querySelector<HTMLElement>('.selection-actions');
      row.classList.remove('is-compact', 'is-compact-chips');
      selection?.classList.remove('is-compact');
      const needsActions = required() > available;
      let needsChips = false;
      let needsSelection = false;
      if (needsActions) {
        row.classList.add('is-compact');
        needsChips = required() > available;
      }
      if (needsChips) {
        // Icons and bare numbers still too wide: the selection group gives up its words,
        // or on a phone-width window the actions were pushed off the edge of the page.
        row.classList.add('is-compact-chips');
        needsSelection = required() > available;
      }
      row.classList.toggle('is-compact', needsActions);
      row.classList.toggle('is-compact-chips', needsChips);
      selection?.classList.toggle('is-compact', needsSelection);
      setCompactActions(needsActions);
      setCompactChips(needsChips);
      setCompactSelection(needsSelection);
      queueMicrotask(() => {
        measuring = false;
      });
    };
    // Once per frame: a burst of changes — a counter and a button in the same frame — is
    // one layout, not one per change.
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
    // The row is always as wide as its container, so a button appearing or losing its
    // words never resizes it; what changes is its contents, and that is what re-measures.
    const contents = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure);
    // Elements appearing or leaving change the width; a counter's digits do not, so text
    // changes are not watched.
    contents?.observe(row, { childList: true, subtree: true });
    window.addEventListener('resize', measure);
    detach.current = () => {
      if (scheduled !== null) cancelAnimationFrame(scheduled);
      resize?.disconnect();
      contents?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return { ref, compactActions, compactChips, compactSelection };
}
