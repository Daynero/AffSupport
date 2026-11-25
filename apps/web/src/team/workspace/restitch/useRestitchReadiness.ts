/**
 * How much of a space is ready for instant re-stitching, before anyone presses anything (071).
 *
 * The preparation used to say nothing until it ran, so the one number that sells it — how many
 * of the space's videos would re-stitch in seconds right now — was never on screen. This reads
 * it the same way the run does: every video, and which of them already carry a usable
 * preparation for their current bytes.
 */

import { useEffect, useState } from 'react';
import { usablePrep } from '@video-compressor/shared';
import { teamApi } from '../../../api/team';
import { listVideos } from '../../restitch/useRestitchPreparation';

export interface RestitchReadiness {
  total: number;
  ready: number;
  /** When the newest preparation was made; null when none is. */
  lastPreparedAt: string | null;
}

export function useRestitchReadiness(
  teamId: string,
  enabled: boolean,
  /** Changes whenever a run settles, so the count is read again. */
  revision: unknown
): RestitchReadiness | null {
  const [readiness, setReadiness] = useState<RestitchReadiness | null>(null);
  useEffect(() => {
    if (!enabled) {
      setReadiness(null);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      const videos = await listVideos(teamId, controller.signal);
      if (controller.signal.aborted) return;
      const known = await teamApi.getMaterialRestitchPrep(
        teamId,
        videos.map(video => video.id)
      );
      if (controller.signal.aborted) return;
      let ready = 0;
      let lastPreparedAt: string | null = null;
      for (const video of videos) {
        const prep = known.get(video.id) ?? null;
        if (!usablePrep(prep, video.driveVersion)) continue;
        ready += 1;
        if (prep && (!lastPreparedAt || prep.preparedAt > lastPreparedAt))
          lastPreparedAt = prep.preparedAt;
      }
      setReadiness({ total: videos.length, ready, lastPreparedAt });
    })().catch(() => {
      // The count is a courtesy: without it the card still offers the run.
      if (!controller.signal.aborted) setReadiness(null);
    });
    return () => controller.abort();
  }, [teamId, enabled, revision]);
  return readiness;
}
