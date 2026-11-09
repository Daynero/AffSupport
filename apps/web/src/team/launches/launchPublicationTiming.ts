import type { LaunchCatalogConfig } from '@video-compressor/shared';

/** The server refuses a deferred link time that is not in the future. A reopened launch keeps
 * its old time, so the form must say so before anyone presses "Generate". */
export const LAUNCH_PUBLICATION_MIN_LEAD_MS = 60_000;

export function launchPublicationTimePassed(
  catalog: Pick<LaunchCatalogConfig, 'videoPublication'> | null | undefined,
  now = Date.now()
): boolean {
  const publication = catalog?.videoPublication;
  if (publication?.mode !== 'scheduled') return false;
  const due = Date.parse(publication.dueAt);
  return Number.isFinite(due) && due <= now + LAUNCH_PUBLICATION_MIN_LEAD_MS;
}
