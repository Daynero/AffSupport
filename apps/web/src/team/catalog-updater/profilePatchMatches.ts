import type { CatalogUpdateProfilePatch } from '@video-compressor/shared';
import type { CatalogSnapshot } from './useCatalogInlineChanges';

/** Compare only requested fields; unrelated runtime changes do not confirm a save. */
export function profilePatchMatches(snapshot: CatalogSnapshot, patch: CatalogUpdateProfilePatch) {
  if (
    patch.videoVariantCount !== undefined &&
    snapshot.profile.videoVariantCount !== patch.videoVariantCount
  )
    return false;
  if (patch.updateInterval !== undefined && snapshot.interval !== patch.updateInterval)
    return false;
  if (patch.schedule !== undefined) {
    const saved = snapshot.profile.schedule ?? null;
    if (
      patch.schedule === null
        ? saved !== null
        : saved?.time !== patch.schedule.time ||
          saved?.timeZone !== patch.schedule.timeZone ||
          saved?.weekday !== patch.schedule.weekday
    )
      return false;
  }
  for (const key of [
    'refreshImages',
    'refreshTexts',
    'growProducts',
    'randomLinkVariation',
    'restitch'
  ] as const) {
    if (patch[key] !== undefined && snapshot.profile[key] !== patch[key]) return false;
  }
  return true;
}
