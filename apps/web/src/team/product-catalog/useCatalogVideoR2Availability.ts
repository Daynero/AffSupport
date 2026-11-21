import { useCallback, useEffect, useState } from 'react';
import type { CatalogVideoR2Availability } from '@video-compressor/shared';
import type { CatalogVideoR2Client } from '../../api/team-catalog-video-r2';

/** Pauses before the automatic retries of a failed read; then it waits for the person. */
export const CATALOG_VIDEO_R2_AVAILABILITY_RETRIES_MS = [2_000, 5_000, 10_000] as const;
/** One read that has not answered by then counts as failed, so a hung request retries too. */
export const CATALOG_VIDEO_R2_AVAILABILITY_TIMEOUT_MS = 12_000;

/**
 * The last answer per client and space, so a switch that mounts again — every launch the
 * editor opens — shows at once and is refreshed in the background, instead of appearing a
 * beat after the shelf around it (next QA 2026-11-21). Keyed by the client so tests that
 * hand in their own client never see another's answer.
 */
const known = new WeakMap<CatalogVideoR2Client, Map<string, CatalogVideoR2Availability>>();
const inFlight = new WeakMap<CatalogVideoR2Client, Set<string>>();
const listeners = new Set<() => void>();

function knownAvailability(client: CatalogVideoR2Client, teamId: string) {
  return known.get(client)?.get(teamId) ?? null;
}

function remember(
  client: CatalogVideoR2Client,
  teamId: string,
  value: CatalogVideoR2Availability
): void {
  const answers = known.get(client) ?? new Map<string, CatalogVideoR2Availability>();
  answers.set(teamId, value);
  known.set(client, answers);
  for (const listener of listeners) listener();
}

/** Asks ahead of the switch — on the launches board, before an editor is open. */
export function prefetchCatalogVideoR2Availability(
  teamId: string,
  client: CatalogVideoR2Client
): void {
  if (knownAvailability(client, teamId)) return;
  const pending = inFlight.get(client) ?? new Set<string>();
  if (pending.has(teamId)) return;
  pending.add(teamId);
  inFlight.set(client, pending);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), CATALOG_VIDEO_R2_AVAILABILITY_TIMEOUT_MS);
  void client
    .availability(teamId, { signal: controller.signal })
    .then(value => remember(client, teamId, value))
    // A failed prefetch is nobody's to report: the switch reads again, with its retries.
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(deadline);
      pending.delete(teamId);
    });
}

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
  const [availability, setAvailability] = useState<CatalogVideoR2Availability | null>(() =>
    knownAvailability(client, teamId)
  );
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);

  // A prefetch that lands while this switch is already waiting shows it right away.
  useEffect(() => {
    const listener = () => {
      const value = knownAvailability(client, teamId);
      if (value) setAvailability(value);
    };
    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, [client, teamId]);

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
          remember(client, teamId, value);
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
