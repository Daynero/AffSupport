import type { LaunchCatalogConfig } from '@video-compressor/shared';
import { resolveCatalogPublicationDraft } from '../product-catalog/catalogPublicationDraft';

/** The server refuses a deferred link time that is not in the future. A reopened launch keeps
 * its old time, so the form must say so before anyone presses "Generate". */
export const LAUNCH_PUBLICATION_MIN_LEAD_MS = 60_000;

/** When the deferred link would be written, even if the form could not resolve `dueAt`
 * (a past time leaves it empty). Null when the time itself is incomplete or invalid. */
function scheduledInstant(
  publication: Extract<NonNullable<LaunchCatalogConfig['videoPublication']>, { mode: 'scheduled' }>
): number | null {
  const due = Date.parse(publication.dueAt);
  if (Number.isFinite(due)) return due;
  try {
    // Resolve against the epoch: only the instant is needed, never "is it in the past".
    const resolved = resolveCatalogPublicationDraft(
      { localDateTime: publication.localDateTime, timeZone: publication.timeZone },
      0
    );
    return resolved.kind === 'resolved'
      ? Date.parse(resolved.publication.dueAt)
      : Math.max(...resolved.choices.map(choice => Date.parse(choice.dueAt)));
  } catch {
    return null;
  }
}

export function launchPublicationTimePassed(
  catalog: Pick<LaunchCatalogConfig, 'videoPublication'> | null | undefined,
  now = Date.now()
): boolean {
  const publication = catalog?.videoPublication;
  if (publication?.mode !== 'scheduled') return false;
  const due = scheduledInstant(publication);
  return due !== null && due <= now + LAUNCH_PUBLICATION_MIN_LEAD_MS;
}
