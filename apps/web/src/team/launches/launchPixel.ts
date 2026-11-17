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
