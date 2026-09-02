import { useEffect, useRef } from 'react';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { requestTeamPosterFrame } from '../../api/client';
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
