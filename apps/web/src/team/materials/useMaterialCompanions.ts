import { useEffect, useState } from 'react';
import { teamApi } from '../../api/team';
import type { MaterialCompanions, MaterialRef } from './actions';

/**
 * What lives beside this file, read once and shown wherever the file appears.
 *
 * A video's transcript and its product catalog are companion materials (012,
 * 022) and the product treated them as three unrelated features: the catalog
 * was readable only from the card that created it, the transcript only from
 * the panel that made it, and a video seen anywhere else looked like a video
 * with nothing beside it. So "copy the text" existed but could not be reached,
 * and "product catalog" offered to make a second one next to the first.
 *
 * ## One material at a time, on purpose
 *
 * These are two round trips per material, which is right for a file in focus —
 * a detail pane, an attachment on a task, a preview — and wrong for a folder
 * of fifty rows. A list gets its companions from the list query or it does not
 * get them; it does not get them fifty times. `enabled` is how a surface says
 * which of the two it is.
 */
export function useMaterialCompanions(
  material: Pick<MaterialRef, 'id' | 'teamId' | 'kind' | 'category' | 'draft'>,
  {
    enabled = true,
    /** Bumped by the space's realtime revision, so a teammate's work appears. */
    revision = 0
  }: { enabled?: boolean; revision?: number } = {}
): MaterialCompanions | undefined {
  const [companions, setCompanions] = useState<MaterialCompanions | undefined>(undefined);
  const { id, teamId, kind, category, draft } = material;
  // Only a real video has either of these, and a draft has no server identity
  // to ask about.
  const applicable = enabled && kind !== 'folder' && category === 'video' && !draft;

  useEffect(() => {
    if (!applicable) {
      setCompanions(undefined);
      return;
    }
    let active = true;
    void Promise.all([
      teamApi.getTranscriptCompanion(teamId, id).catch(() => null),
      teamApi.getProductCatalog(teamId, id).catch(() => null)
    ]).then(([transcript, catalog]) => {
      if (!active) return;
      setCompanions({
        transcript: transcript ? { ready: transcript.hasText } : null,
        productCatalog: catalog
          ? { link: catalog.sheetUrl, productCount: catalog.productCount ?? null }
          : null
      });
    });
    return () => {
      active = false;
    };
  }, [applicable, id, revision, teamId]);

  return companions;
}
