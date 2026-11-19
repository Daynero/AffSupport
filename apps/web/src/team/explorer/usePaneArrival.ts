import { useEffect, useState } from 'react';

/**
 * How long the first press waits before the detail pane takes its width.
 *
 * The pane arrives with a selection (024, FR-091), and arriving narrows the
 * list by a third. A double-click is two presses: the first selected the row
 * and brought the pane in, the list reflowed under the pointer, and the second
 * press landed on the pane instead of the row, so a folder double-clicked
 * anywhere right of its name never opened (next QA 2026-11-17). Waiting out a
 * double-click lets both presses land on the same row; a row that opens takes
 * the selection with it and the pane never shows.
 */
export const PANE_ARRIVAL_MS = 400;

/** Whether the pane is shown: at once while it stays, after a pause when it comes. */
export function usePaneArrival(present: boolean, delayMs = PANE_ARRIVAL_MS): boolean {
  const [shown, setShown] = useState(present);
  useEffect(() => {
    if (!present) {
      setShown(false);
      return;
    }
    if (shown) return;
    const timer = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [present, shown, delayMs]);
  return present && shown;
}
