import { useEffect, useRef } from 'react';
import type { TeamMaterialRow } from '@video-compressor/shared';
import {
  requestSpaceDerivatives,
  requestTeamPosterFrame,
  spaceDerivativesAgentReady
} from '../../api/client';
import { isR2Space, spaceStorageApi } from '../../api/space-storage';
import { teamApi } from '../../api/team';

/**
 * A picture for the videos Google Drive never made one for (owner, 2026-09-02).
 *
 * Drive decides on its own whether a file gets a thumbnail, and for plenty it
 * never does — the folder then shows rows of identical glyphs and the only way
 * to know what a file is, is to open it. The machine that can answer is already
 * paired: it reads the file through the grant any other work would use, takes
 * one frame, and hands the picture to the same cache the provider's thumbnails
 * live in, so every surface shows it without knowing where it came from.
 *
 * One at a time, only for what is on screen, and each material asked once per
 * session: a folder of two hundred videos must not become two hundred
 * downloads the moment it is opened.
 */
/** How many picture jobs one look at an R2 folder hands this computer's Soty, one after another. */
const SPACE_JOBS_PER_LOOK = 5;

export function usePosterFrames(input: {
  teamId: string;
  rows: readonly TeamMaterialRow[];
  /** False while the local app cannot be asked (not paired, older build). */
  enabled: boolean;
  onRendered: () => void;
}): void {
  const { teamId, rows, enabled, onRendered } = input;
  const asked = useRef(new Set<string>());
  const running = useRef(false);

  useEffect(() => {
    if (!enabled || running.current) return;
    if (isR2Space(teamId)) {
      // 057 T047: an R2 space's pictures are its own. A file whose pictures are still on their
      // way is a job on the server; this computer's Soty takes one at a time while the folder
      // shows one, and the folder hears when it is done (a `derivative` signal).
      const waiting = rows.some(
        row =>
          (row.kind === 'image' || row.kind === 'video') &&
          row.previewState === 'pending' &&
          !asked.current.has(row.id)
      );
      if (!waiting) return;
      for (const row of rows) if (row.previewState === 'pending') asked.current.add(row.id);
      running.current = true;
      void (async () => {
        try {
          // Asked first, so a Soty that cannot take a job never costs the job an attempt.
          if (!(await spaceDerivativesAgentReady())) return;
          // A few jobs per look, the space's oldest first; the rest wait for the next folder.
          for (let taken = 0; taken < SPACE_JOBS_PER_LOOK; taken += 1) {
            const job = await spaceStorageApi.claimDerivativeJob(teamId);
            if (!job || !(await requestSpaceDerivatives(job))) break;
          }
        } catch {
          // Nothing to say: the tile keeps saying its picture is on its way.
        } finally {
          running.current = false;
        }
      })();
      return;
    }
    const candidate = rows.find(
      row =>
        row.category === 'video' &&
        row.kind === 'video' &&
        !row.thumbnailReady &&
        row.previewState === 'unavailable' &&
        !asked.current.has(row.id)
    );
    if (!candidate) return;
    asked.current.add(candidate.id);
    running.current = true;
    void (async () => {
      try {
        const grant = await teamApi.requestDownload(teamId, candidate.id, 'agent');
        if (grant.kind !== 'agent') return;
        const stored = await requestTeamPosterFrame({
          materialId: candidate.id,
          grant: grant.grant
        });
        if (stored) onRendered();
      } catch {
        // Nothing to say: the tile keeps its glyph, exactly as before.
      } finally {
        running.current = false;
      }
    })();
  }, [enabled, onRendered, rows, teamId]);
}
