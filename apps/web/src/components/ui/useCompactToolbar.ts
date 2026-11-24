/**
 * A toolbar that gives up words before it gives up room (070 T034).
 *
 * Every tool page has a row of actions that has to fit a laptop and a phone: the
 * compressor's, the stitcher's, the transcription's and the landing optimiser's batch
 * toolbar, and the landing viewer's top bar. When the row runs out of room it drops its
 * words and keeps its icons, and when it is narrower still it gives up more — one stage at
 * a time, each tried with the previous ones applied and measured again, and undone in
 * reverse when the window grows.
 *
 * ## Why a measurement and not a media query
 *
 * The question is not how wide the window is but how wide the row's *contents* are: a
 * Ukrainian label is longer than an English one, a selection adds a group, a running batch
 * adds a counter. A container query knows the row's width and nothing about what is in it;
 * React Aria's `Toolbar` gives the row its keyboard, not its size. So the row is measured.
 *
 * ## How
 *
 * `useToolbarStages` is the mechanism: it toggles each stage's class, asks the caller's
 * `fits` whether the row now fits, and re-measures on a resize of the row or the window, on
 * an element appearing or leaving inside it, and once the real face has loaded. Classes
 * only — the row re-measures on every change of its contents, and a state write per
 * measurement would re-render the page for a value nothing reads. A caller that does read
 * the result asks for it through `onMeasure`.
 *
 * `useCompactToolbar` is the batch toolbar's three stages on top of it. The landing viewer
 * passes its own four, with its own idea of how wide its groups want to be.
 *
 * The stylesheet does the rest: `.is-compact` hides `.action-label` and so on. The hook
 * only decides when.
 */

import { useCallback, useRef, useState, type RefCallback } from 'react';

/** One thing the row gives up: a class, on the row or on an element inside it. */
export interface ToolbarStage {
  className: string;
  /** Where the class goes. The row itself when omitted. */
  target?: (row: HTMLElement) => HTMLElement | null;
}

export interface ToolbarStagesOptions {
  /** In the order they are given up. A string is a class on the row. */
  stages: ReadonlyArray<ToolbarStage | string>;
  /** Whether the row's contents fit, with the stages applied so far. */
  fits: (row: HTMLElement) => boolean;
  /** How many stages the row needed, after every measurement. */
  onMeasure?: (applied: number) => void;
}

export interface ToolbarStages {
  /** Attach to the row. A callback, so a row that mounts later is still measured. */
  ref: RefCallback<HTMLElement>;
}

export function useToolbarStages(options: ToolbarStagesOptions): ToolbarStages {
  // The latest options, read at measurement time: the ref has to stay one function for the
  // row's lifetime, or React would detach and re-attach the observers on every render.
  const latest = useRef(options);
  latest.current = options;
  const detach = useRef<(() => void) | null>(null);

  // A callback ref rather than an effect over a ref object: a batch toolbar is rendered only
  // once there are jobs, so an effect that ran on mount found nothing to observe and never
  // ran again. The observers attach the moment the row exists and go with it.
  const ref = useCallback<RefCallback<HTMLElement>>(row => {
    detach.current?.();
    detach.current = null;
    if (!row) return;
    const resolve = (stage: ToolbarStage | string) =>
      typeof stage === 'string'
        ? { className: stage, element: row }
        : { className: stage.className, element: stage.target ? stage.target(row) : row };

    let measuring = false;
    let scheduled: number | null = null;
    const measureNow = () => {
      // The measurement toggles classes, which the mutation observer would report as a
      // change of contents; it is not one.
      if (measuring) return;
      measuring = true;
      const { stages, fits, onMeasure } = latest.current;
      const resolved = stages.map(resolve);
      // Measured with everything given back first, so a window that grew can undo a stage
      // instead of staying compact forever.
      for (const { className, element } of resolved) element?.classList.remove(className);
      let applied = 0;
      while (applied < resolved.length && !fits(row)) {
        const { className, element } = resolved[applied]!;
        element?.classList.add(className);
        applied += 1;
      }
      onMeasure?.(applied);
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
    // The row is usually as wide as its container, so a button appearing or losing its
    // words never resizes it; what changes is its contents, and that is what re-measures.
    // Text changes are not watched: a counter's digits do not change the layout.
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

export interface CompactToolbar {
  /** Attach to the toolbar row. A callback, so a row that mounts later is still measured. */
  ref: RefCallback<HTMLElement>;
  /** The action buttons have dropped their words (`.is-compact` on the row). */
  compactActions: boolean;
  /** The counters have dropped theirs too (`.is-compact-chips` on the row). */
  compactChips: boolean;
  /** The selection group has lost its words too; set on the group's own element. */
  compactSelection: boolean;
}

/**
 * How wide the batch toolbar wants to be: the sum of what each group needs.
 *
 * The chips container shrinks (and hides its overflow) instead of pushing the row wider,
 * so comparing the row's own scrollWidth with its clientWidth always reported "fits" and
 * the collapsed state could never lift.
 */
function batchToolbarFits(row: HTMLElement): boolean {
  const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
  const children = Array.from(row.children) as HTMLElement[];
  const required =
    children.reduce((total, child) => total + child.scrollWidth, 0) +
    gap * Math.max(0, children.length - 1);
  return required <= row.clientWidth;
}

/**
 * The third stage goes on the selection group itself rather than the row: the pages render
 * that element with a constant class, so a re-render never rewrites what is set here, and
 * no page has to know the stage exists.
 */
const BATCH_TOOLBAR_STAGES: ReadonlyArray<ToolbarStage | string> = [
  'is-compact',
  'is-compact-chips',
  { className: 'is-compact', target: row => row.querySelector<HTMLElement>('.selection-actions') }
];

/**
 * The batch toolbar's collapse, shared by every tool that has one.
 *
 * Words go first (`.is-compact`), then the counters' (`.is-compact-chips`), then the
 * selection group's — on a phone-width window the actions were otherwise pushed off the
 * edge of the page. Written once because the compressor, the stitcher, the transcription
 * and the landing optimiser render the same toolbar, and a second copy of this measurement
 * would be a second chance for them to disagree about when a window is too narrow.
 */
export function useCompactToolbar(): CompactToolbar {
  const [applied, setApplied] = useState(0);
  const { ref } = useToolbarStages({
    stages: BATCH_TOOLBAR_STAGES,
    fits: batchToolbarFits,
    onMeasure: setApplied
  });
  return {
    ref,
    compactActions: applied >= 1,
    compactChips: applied >= 2,
    compactSelection: applied >= 3
  };
}
