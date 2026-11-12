import { isLaunchTimezone } from '@video-compressor/shared';

/**
 * Legacy IANA names some browsers still report for the browser's own zone. They name the
 * same clock, but a draft spelled with one and its copy spelled with the other read as
 * different settings; every launch-side default goes through the canonical name.
 *
 * Kept in the web, not in the shared package: shared is versioned with the desktop agent,
 * and a web-only fix must not require a new agent release.
 */
const LEGACY_LAUNCH_TIMEZONES: Readonly<Record<string, string>> = {
  'Europe/Kiev': 'Europe/Kyiv',
  'Europe/Uzhgorod': 'Europe/Kyiv',
  'Europe/Zaporozhye': 'Europe/Kyiv',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon'
};

export function canonicalLaunchTimezone(value: string): string {
  const canonical = LEGACY_LAUNCH_TIMEZONES[value];
  return canonical && isLaunchTimezone(canonical) ? canonical : value;
}

/** The browser's zone under its canonical name, for every launch default. */
export function launchBrowserTimezone(): string {
  return canonicalLaunchTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}
