import { isRecord } from '../contract.js';
import {
  parseCatalogVideoPublication,
  type CatalogVideoPublicationRequest
} from '../catalog-publication.js';
import type { LaunchCatalogConfig } from '../launches.js';
export type LaunchCatalogVideoConfig = Pick<
  LaunchCatalogConfig,
  'catalogVideoProtocolVersion' | 'videoVariationCount' | 'videoPublication'
>;
/** Historical revisions retain their original due instant after it passes. Only
 * new admission validates against the authoritative current server clock. */
export function parseLaunchCatalogVideoConfig(
  value: unknown,
  strict: boolean
): LaunchCatalogVideoConfig | null {
  if (!isRecord(value)) return null;
  if (value.catalogVideoProtocolVersion === undefined) {
    return value.videoVariationCount === undefined && value.videoPublication === undefined
      ? {}
      : null;
  }
  if (
    value.catalogVideoProtocolVersion !== 1 ||
    typeof value.videoVariationCount !== 'number' ||
    !Number.isFinite(value.videoVariationCount)
  )
    return null;
  const n = value.videoVariationCount;
  if (
    strict &&
    (!Number.isSafeInteger(n) ||
      n < 1 ||
      typeof value.productCount !== 'number' ||
      n > value.productCount ||
      (!value.restitchEnabled && n !== 1))
  )
    return null;
  const raw = value.videoPublication;
  if (!isRecord(raw)) return null;
  let publication: CatalogVideoPublicationRequest;
  if (raw.mode === 'immediate' && Object.keys(raw).every(k => k === 'mode'))
    publication = { mode: 'immediate' };
  else if (
    raw.mode === 'scheduled' &&
    Object.keys(raw).every(k =>
      ['mode', 'localDateTime', 'timeZone', 'resolvedOffset', 'dueAt'].includes(k)
    ) &&
    ['localDateTime', 'timeZone', 'resolvedOffset', 'dueAt'].every(
      k => typeof raw[k] === 'string' && String(raw[k]).length <= 160
    )
  ) {
    publication = {
      mode: 'scheduled',
      localDateTime: String(raw.localDateTime),
      timeZone: String(raw.timeZone),
      resolvedOffset: String(raw.resolvedOffset),
      dueAt: String(raw.dueAt)
    };
    if (strict) {
      try {
        parseCatalogVideoPublication(publication, 0);
      } catch {
        return null;
      }
    }
  } else return null;
  return { catalogVideoProtocolVersion: 1, videoVariationCount: n, videoPublication: publication };
}
