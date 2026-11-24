import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { useRestitchDelivery } from '../restitch/useRestitchDelivery';

/**
 * The explorer's re-stitched deliveries (015), out of `ExplorerShell` (070, FR-001): the
 * running one the corner panel shows, and the queue a selection of several videos waits in.
 */
export function useExplorerRestitch(teamId: string, settingsOpen: boolean) {
  /* 015 — one running re-stitched delivery per material, held here rather than in the row:
     a delivery outlives the menu that started it and the row that scrolled past. */
  const restitch = useRestitchDelivery(teamId);
  /*
   * The one delivery worth a panel.
   *
   * Only ever one runs at a time — the menu starts a single file — so the first running state
   * is the answer, and the toasts keep carrying everything that has already finished.
   */
  const deliveringMaterial = useMemo(() => {
    for (const [materialId, state] of Object.entries(restitch.states)) {
      if (state.kind === 'running') return { materialId, state };
    }
    return null;
  }, [restitch.states]);
  /*
   * Several videos, one at a time.
   *
   * A re-stitch is the heaviest thing this machine does — it reads a whole file and writes
   * another — so a selection of five started at once would fight itself for the same cores
   * and finish later than five in a row. The panel shows whichever is running; the rest wait
   * their turn, and a failure stops that video rather than the queue.
   */
  const deliverRestitched = useCallback(
    async (
      rows: ReadonlyArray<
        Pick<TeamMaterialRow, 'id' | 'name' | 'category'> & { driveVersion?: string | null }
      >
    ) => {
      for (const row of rows) {
        if (row.category !== 'video') continue;
        /* A search result has no Drive version (070): the delivery then reads the file rather
           than reuse a preparation made for a version it cannot name. */
        await restitch
          .deliver({
            materialId: row.id,
            fileName: row.name,
            driveVersion: row.driveVersion ?? null
          })
          .catch(() => {
            // Each delivery already reports its own outcome; one refusal is not the others'.
          });
      }
    },
    [restitch]
  );
  /* The delivery that met an unconfigured space waits for the settings to close, then
     continues by itself — the member gets the file they asked for without a second click. */
  const settingsWasOpen = useRef(false);
  useEffect(() => {
    if (settingsWasOpen.current && !settingsOpen && restitch.pending) void restitch.resume();
    settingsWasOpen.current = settingsOpen;
  }, [settingsOpen, restitch]);
  return { restitch, deliveringMaterial, deliverRestitched };
}
