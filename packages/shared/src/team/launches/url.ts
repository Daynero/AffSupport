import { LAUNCH_SUB_VALUE_MAX, LAUNCH_URL_MAX, type LaunchSubSlot } from '../launches.js';
export function isLaunchUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    !/^https?:\/\/[^/\\]/iu.test(value) ||
    value.includes('\\') ||
    value.length > LAUNCH_URL_MAX ||
    /[\s\p{Cc}]/u.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      /^(https?):$/u.test(url.protocol) && Boolean(url.hostname) && !url.username && !url.password
    );
  } catch {
    return false;
  }
}
/** Literal aliases share a logical slot while keeping the caller's spelling. */
function subSlot(key: string): LaunchSubSlot | undefined {
  switch (key) {
    case 'sub1':
    case 'sub_1':
      return 'sub1';
    case 'sub2':
    case 'sub_2':
      return 'sub2';
    case 'sub3':
    case 'sub_3':
      return 'sub3';
    default:
      return undefined;
  }
}
/** SUB parameters the URL does not contain and therefore cannot receive a generated value. */
export function missingLaunchSubSlots(original: string): LaunchSubSlot[] {
  if (!isLaunchUrl(original)) return [];
  const fragment = original.indexOf('#');
  const body = fragment < 0 ? original : original.slice(0, fragment);
  const queryStart = body.indexOf('?');
  if (queryStart < 0) return ['sub1', 'sub2', 'sub3'];
  const query = body.slice(queryStart + 1);
  const present = new Set(
    query.split('&').map(segment => {
      const equal = segment.indexOf('=');
      return subSlot(equal < 0 ? segment : segment.slice(0, equal));
    })
  );
  return (['sub1', 'sub2', 'sub3'] as const).filter(slot => !present.has(slot));
}
/** Query keys a tracker link carries its Facebook pixel under; the spaces' links use fb_pixel. */
const PIXEL_KEYS = new Set(['fb_pixel', 'fb_pixel_id', 'pixel', 'pixel_id']);
/**
 * The Facebook pixel a launch link names, or null. Only a literal pixel id counts — a
 * `{{placeholder}}` or a half-typed value is not one, so the editor shows nothing for it.
 */
export function launchPixel(original: string | null | undefined): string | null {
  if (typeof original !== 'string') return null;
  const fragment = original.indexOf('#');
  const body = fragment < 0 ? original : original.slice(0, fragment);
  const queryStart = body.indexOf('?');
  if (queryStart < 0) return null;
  for (const segment of body.slice(queryStart + 1).split('&')) {
    const equal = segment.indexOf('=');
    if (equal < 0 || !PIXEL_KEYS.has(segment.slice(0, equal).toLowerCase())) continue;
    let value = segment.slice(equal + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    value = value.trim();
    if (/^[0-9]{6,20}$/u.test(value)) return value;
  }
  return null;
}
/** Patch raw query values. Never round-trip untouched bytes through a serializer. */
export function patchLaunchUrl(
  original: string,
  values: Record<LaunchSubSlot, string | null>,
  catalogSlots: ReadonlySet<LaunchSubSlot> = new Set()
): string {
  if (!isLaunchUrl(original)) throw new Error('LAUNCH_URL_INVALID');
  for (const [slot, value] of Object.entries(values))
    if (
      value !== null &&
      (!value ||
        (catalogSlots.has(slot as LaunchSubSlot) && value.length > LAUNCH_SUB_VALUE_MAX) ||
        (catalogSlots.has(slot as LaunchSubSlot)
          ? /[\p{Cc}\p{Cs}]/u.test(value)
          : !/^[A-Za-z0-9_-]+$/u.test(value)))
    )
      throw new Error('LAUNCH_SUB_INVALID');
  const hash = original.indexOf('#');
  const body = hash < 0 ? original : original.slice(0, hash);
  const fragment = hash < 0 ? '' : original.slice(hash);
  const query = body.indexOf('?');
  const prefix = query < 0 ? body : body.slice(0, query + 1);
  const raw =
    query < 0
      ? ''
      : body
          .slice(query + 1)
          .split('&')
          .map(segment => {
            const equal = segment.indexOf('=');
            const key = equal < 0 ? segment : segment.slice(0, equal);
            const slot = subSlot(key);
            if (slot && values[slot] !== null) return `${key}=${encodeURIComponent(values[slot])}`;
            return segment;
          })
          .join('&');
  const result = prefix + raw + fragment;
  if (result.length > LAUNCH_URL_MAX) throw new Error('LAUNCH_URL_INVALID');
  return result;
}
