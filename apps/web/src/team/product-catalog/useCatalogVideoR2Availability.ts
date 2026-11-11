import { useCallback, useEffect, useState } from 'react';
import type { CatalogVideoR2Availability } from '@video-compressor/shared';
import type { CatalogVideoR2Client } from '../../api/team-catalog-video-r2';

/** Pauses before the automatic retries of a failed read; then it waits for the person. */
export const CATALOG_VIDEO_R2_AVAILABILITY_RETRIES_MS = [2_000, 5_000, 10_000] as const;
/** One read that has not answered by then counts as failed, so a hung request retries too. */
export const CATALOG_VIDEO_R2_AVAILABILITY_TIMEOUT_MS = 12_000;

export interface CatalogVideoR2AvailabilityRead {
  /** The server's answer; null while it is being read or after every attempt failed. */
  availability: CatalogVideoR2Availability | null;
  /** Every attempt failed: unknown, not "unavailable". */
  failed: boolean;
  retry(): void;
}

/**
 * The R2 option's availability for a space (050). Only the server's answer decides
 * whether the option is offered: a read that fails or hangs under load is retried
 * a few times and then reported as unknown, never taken for "not available" — that
 * made the option vanish without a word on a busy beta.
 */
export function useCatalogVideoR2Availability(
  teamId: string,
  client: CatalogVideoR2Client
): CatalogVideoR2AvailabilityRead {
  const [availability, setAvailability] = useState<CatalogVideoR2Availability | null>(null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: AbortController | null = null;
    setFailed(false);
    const attempt = (index: number) => {
      const controller = new AbortController();
      current = controller;
      const deadline = setTimeout(
        () => controller.abort(),
        CATALOG_VIDEO_R2_AVAILABILITY_TIMEOUT_MS
      );
      void client
        .availability(teamId, { signal: controller.signal })
        .then(value => {
          if (!active) return;
          setAvailability(value);
          setFailed(false);
        })
        .catch(() => {
          if (!active) return;
          const pause = CATALOG_VIDEO_R2_AVAILABILITY_RETRIES_MS[index];
          if (pause === undefined) {
            setFailed(true);
            return;
          }
          timer = setTimeout(() => attempt(index + 1), pause);
        })
        .finally(() => clearTimeout(deadline));
    };
    attempt(0);
    return () => {
      active = false;
      clearTimeout(timer);
      current?.abort();
    };
  }, [client, teamId, round]);

  const retry = useCallback(() => setRound(value => value + 1), []);
  return { availability, failed, retry };
}
