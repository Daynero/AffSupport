/**
 * How much of a space is ready for instant re-stitching, before anyone presses anything (071).
 *
 * The preparation used to say nothing until it ran, so the one number that sells it — how many
 * of the space's videos would re-stitch in seconds right now — was never on screen. This reads
 * it the same way the run does: every video, and which of them already carry a usable
 * preparation for their current bytes.
 *
 * A video Soty re-stitches anywhere counts from then on, whoever did it (owner 2026-11-25): a
 * download re-stitched by hand stores what the agent read (`useRestitchDelivery`), and a catalog
 * round or a launch stores it with the agent's finalize (20261224300000). So the count is read
 * again while the card is open, without a reload, when:
 *
 * - the space's realtime feed says something changed in it (`live`: an operation finished — a
 *   catalog round's or a launch's re-stitch is one);
 * - this page stored a record itself (`announceRestitchPrep`);
 * - the page comes back into view.
 *
 * Reading the count lists every video of the space, so the reads are settled (a burst of
 * changes is one read, a couple of seconds after the last) and spaced (at most one every
 * fifteen seconds from these signals).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usablePrep } from '@video-compressor/shared';
import { teamApi } from '../../../api/team';
import { listVideos } from '../../restitch/useRestitchPreparation';

export interface RestitchReadiness {
  total: number;
  ready: number;
  /** When the newest preparation was made; null when none is. */
  lastPreparedAt: string | null;
}

const PREP_CHANGED = 'soty:restitch-prep-changed';
/** A burst of changes settles into one read this long after the last of them. */
export const READINESS_SETTLE_MS = 2_000;
/** And these signals never read the space more often than this. */
export const READINESS_MIN_GAP_MS = 15_000;

/** Says that this page just stored a preparation record for the space. */
export function announceRestitchPrep(teamId: string): void {
  try {
    window.dispatchEvent(new CustomEvent(PREP_CHANGED, { detail: teamId }));
  } catch {
    // A count that is a little late is not worth an error.
  }
}

export function useRestitchReadiness(
  teamId: string,
  enabled: boolean,
  /** Changes whenever a run settles, so the count is read again. */
  revision: unknown,
  /** Changes whenever the space's realtime feed reports a change (see the header). */
  live?: unknown
): RestitchReadiness | null {
  const [readiness, setReadiness] = useState<RestitchReadiness | null>(null);
  const [pulse, setPulse] = useState(0);
  const lastRead = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const kick = useCallback(() => {
    if (timer.current !== null) return;
    const wait = Math.max(
      READINESS_SETTLE_MS,
      lastRead.current + READINESS_MIN_GAP_MS - Date.now()
    );
    timer.current = setTimeout(() => {
      timer.current = null;
      setPulse(value => value + 1);
    }, wait);
  }, []);

  // The feed's first value is the one the first read already answers.
  const seenLive = useRef(live);
  useEffect(() => {
    if (Object.is(seenLive.current, live)) return;
    seenLive.current = live;
    if (enabled) kick();
  }, [live, enabled, kick]);

  useEffect(() => {
    if (!enabled) return;
    const onStored = (event: Event) => {
      if ((event as CustomEvent<string>).detail === teamId) kick();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') kick();
    };
    window.addEventListener(PREP_CHANGED, onStored);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(PREP_CHANGED, onStored);
      document.removeEventListener('visibilitychange', onVisible);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [teamId, enabled, kick]);

  useEffect(() => {
    if (!enabled) {
      setReadiness(null);
      return;
    }
    const controller = new AbortController();
    const repeat = lastRead.current > 0;
    lastRead.current = Date.now();
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
      // The count is a courtesy: without it the card still offers the run. A later read that
      // fails keeps the count already on screen rather than hiding it.
      if (!controller.signal.aborted && !repeat) setReadiness(null);
    });
    return () => controller.abort();
  }, [teamId, enabled, revision, pulse]);
  return readiness;
}
