import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TeamMaterialRow } from '@video-compressor/shared';
import type { ExplorerView } from '../routes';
import { foldCompanions } from './companions';

/** The grid never unfolds companions in place; a stable empty set keeps the memo quiet. */
const NO_COMPANIONS_OPEN: ReadonlySet<string> = new Set();

/**
 * The folder's rows with each video's companions folded under it (024, US25), and which
 * videos have them out (070, FR-001, out of `ExplorerShell`).
 */
export function useCompanionFold(
  allRows: TeamMaterialRow[],
  view: ExplorerView,
  currentFolderId: string | null
) {
  /*
   * A transcript and a catalog belong to their video (024, US25): the folder shows the video with
   * a count, and they come out under it on a press. Opened ones are remembered per folder only.
   */
  const [openedCompanions, setOpenedCompanions] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setOpenedCompanions(new Set()), [currentFolderId]);
  /*
   * Only the list unfolds them in place. In the grid a catalog is a grey document tile the size of
   * a thumbnail: opened, two of them pushed every video after them down a row and looked like
   * strangers in the folder. There the video's tile lists them itself, so the grid never unfolds.
   */
  const folded = useMemo(
    () => foldCompanions(allRows, view === 'grid' ? NO_COMPANIONS_OPEN : openedCompanions),
    [allRows, openedCompanions, view]
  );
  const toggleCompanions = useCallback((rowId: string) => {
    setOpenedCompanions(current => {
      const next = new Set(current);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });
  }, []);
  return { folded, openedCompanions, toggleCompanions };
}
