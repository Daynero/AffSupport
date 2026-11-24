import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * How much of the explorer's toolbar fits on its one row (070, T014).
 *
 * - `full` — everything: the arrows, the path, the search box, Upload, the view switch, "…".
 * - `compact` — the search box becomes its magnifier (still named, still one press).
 * - `narrow` — the view switch moves into "…", as two named choices.
 * - `tight` — the arrows and the search move into "…" too; the row is the folder toggle, the
 *   folder you are in, Upload and "…".
 *
 * Nothing is ever dropped: what leaves the row is an item of "…" with its words, never an icon
 * without a name. Measured on the toolbar itself, not the window — the folder tree and the
 * details pane take their share of the same window — and the toolbar's width does not depend
 * on what it shows (it is `min-width: 0` in a fixed column), so a step cannot feed back into
 * the measure that chose it.
 *
 * The steps are the room the fixed controls take in Ukrainian, the longer of the two
 * languages, plus a floor for the path; `extra` is the room of controls that are there only
 * sometimes (the way back to a task, the tree's toggle). An engine that lays nothing out
 * (a test) reports no width and gets `full`.
 */
export type ToolbarFit = 'full' | 'compact' | 'narrow' | 'tight';

const STEPS: ReadonlyArray<[ToolbarFit, number]> = [
  ['full', 800],
  ['compact', 560],
  ['narrow', 440]
];

export function fitFor(width: number, extra = 0): ToolbarFit {
  if (width <= 0) return 'full';
  for (const [fit, min] of STEPS) if (width >= min + extra) return fit;
  return 'tight';
}

export function useToolbarFit(ref: RefObject<HTMLElement | null>, extra = 0): ToolbarFit {
  const [fit, setFit] = useState<ToolbarFit>('full');
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setFit(fitFor(node.clientWidth, extra));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, extra]);
  return fit;
}
