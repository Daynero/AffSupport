/** Coarse OS families we can infer from browser hints. Shared by analytics
 * (cohort reporting) and the download UI (which installer to offer first). */
export type BrowserPlatform = 'macos' | 'windows' | 'linux' | 'other';

/** Pure classifier over a `navigator.platform` + user-agent string. The mac
 * check runs first so values like "Darwin" never match the "win" probe. */
export function platformFromUserAgent(value: string): BrowserPlatform {
  const normalized = value.toLowerCase();
  if (normalized.includes('mac')) return 'macos';
  if (normalized.includes('win')) return 'windows';
  if (normalized.includes('linux')) return 'linux';
  return 'other';
}

export function currentBrowserPlatform(): BrowserPlatform | null {
  if (typeof navigator === 'undefined') return null;
  return platformFromUserAgent(`${navigator.platform} ${navigator.userAgent}`);
}
