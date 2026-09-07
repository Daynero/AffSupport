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
 * The host operating system as the connected local app reports it, which beats
 * anything the browser says about itself.
 *
 * The agent runs on the same machine and derives its advertised capabilities
 * from `process.platform`, so `finder-image-conversion` — gated on a shell
 * integration only macOS has — is a fact about the host rather than a claim in
 * a string. Media buyers routinely browse through profiles that report Windows
 * from a Mac, and those visitors were handed the `.exe` for an installed macOS
 * app that could never take it.
 *
 * Only macOS can be established this way: no advertised capability is
 * Windows-only, so its absence means "not known" and leaves the browser's
 * answer standing. Every agent since 0.5 advertises this list, so an
 * already-installed old build is identified without updating anything.
 */
export function platformFromAgentCapabilities(
  capabilities: readonly string[] | null | undefined
): BrowserPlatform | null {
  if (!capabilities?.length) return null;
  return capabilities.includes('finder-image-conversion') ? 'macos' : null;
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
