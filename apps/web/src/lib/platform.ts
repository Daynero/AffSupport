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

/**
 * Whether a Windows visitor can run the x64 installer, judged from browser
 * hints alone.
 *
 * Deliberately conservative: it answers `false` only when the hints positively
 * say 32-bit (a Windows UA with no 64-bit marker at all). ARM64 Windows reports
 * the same `Win64; x64` markers because it runs x64 apps under emulation, and
 * Soty does run there, so it is not excluded. Telling a capable user "this will
 * not work" is worse than letting an incapable one find out from the installer.
 */
export function windowsX64Supported(value: string): boolean {
  if (platformFromUserAgent(value) !== 'windows') return true;
  return /win64|x64|wow64|arm64/iu.test(value);
}

export function currentWindowsX64Supported(): boolean {
  if (typeof navigator === 'undefined') return true;
  return windowsX64Supported(`${navigator.platform} ${navigator.userAgent}`);
}
