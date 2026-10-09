/**
 * Coarse browser families for analytics cohorts (032, FR-024).
 *
 * Five buckets and nothing finer: the question the data has to answer is
 * "is the Agent link blocked more often in Safari than in Chrome", not which
 * minor version a person runs. A full fingerprint would add identifying
 * power without adding an answer.
 */
export type BrowserFamily = 'safari' | 'chrome' | 'firefox' | 'edge' | 'other';

/**
 * Pure classifier over a user-agent string.
 *
 * Order matters: every Chromium browser advertises `Safari` for compatibility,
 * and Edge advertises `Chrome/` too, so the more specific markers are checked
 * first and Safari is only what is left once the imitators are excluded.
 */
export function browserFamilyFromUserAgent(userAgent: string): BrowserFamily {
  if (userAgent.includes('Edg/')) return 'edge';
  if (userAgent.includes('Chrome/') || userAgent.includes('CriOS')) return 'chrome';
  if (userAgent.includes('Firefox/')) return 'firefox';
  if (
    userAgent.includes('Safari') &&
    !userAgent.includes('Chrome') &&
    !userAgent.includes('Chromium') &&
    !userAgent.includes('CriOS') &&
    !userAgent.includes('Edg')
  ) {
    return 'safari';
  }
  return 'other';
}

export function currentBrowserFamily(): BrowserFamily {
  if (typeof navigator === 'undefined') return 'other';
  return browserFamilyFromUserAgent(navigator.userAgent ?? '');
}
