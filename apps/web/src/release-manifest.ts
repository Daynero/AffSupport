import {
  PRODUCTION_SITE_ORIGIN,
  RELEASE_DOWNLOAD_URL,
  RELEASE_DOWNLOAD_URL_WINDOWS,
  RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64,
  compareProductVersions,
  releaseManifestSigningPayload,
  type ReleaseSummaryLanguage,
  type AppEnvironment,
  type StableReleaseManifest
} from '@video-compressor/shared';
import { currentBrowserPlatform } from './lib/platform';
import { configuredEnvironment } from './lib/config';

export type ReleaseManifestState =
  | { status: 'checking'; manifest: null }
  | { status: 'unavailable'; manifest: null }
  | { status: 'ready'; manifest: StableReleaseManifest };

export type InstalledReleaseStatus =
  'unknown' | 'latest' | 'update_available' | 'update_required' | 'development' | 'newer';

export const RELEASE_MANIFEST_URL = `${PRODUCTION_SITE_ORIGIN}/.well-known/wishly/stable.json`;

/**
 * Beta never consults the production update channel.
 *
 * The manifest URL is derived from the production origin, so an unmodified beta
 * build would query the real channel and could offer a production download to a
 * beta install. The reverse direction — a beta artifact appearing in the channel
 * — is guaranteed by construction, because beta packaging never writes or signs
 * stable.json.
 */
export const RELEASE_MANIFEST_UNAVAILABLE_IN_BETA = 'RELEASE_MANIFEST_BETA';

export async function loadStableReleaseManifest(
  fetcher: typeof fetch = fetch,
  publicKeySpkiBase64: string = RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64,
  environment: AppEnvironment = configuredEnvironment()
): Promise<StableReleaseManifest> {
  if (environment === 'beta') throw new Error(RELEASE_MANIFEST_UNAVAILABLE_IN_BETA);
  const response = await fetcher(RELEASE_MANIFEST_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`RELEASE_MANIFEST_${response.status}`);
  const value = (await response.json()) as unknown;
  if (!validManifest(value)) throw new Error('RELEASE_MANIFEST_INVALID');
  if (!(await manifestSignatureValid(value, publicKeySpkiBase64))) {
    throw new Error('RELEASE_MANIFEST_UNSIGNED');
  }
  return value;
}

/**
 * The manifest decides which binary users are told to download, so it must be
 * signed by the release key — hosting access alone (Cloudflare account, cache
 * poisoning) must not be enough to redirect updates.
 */
async function manifestSignatureValid(
  manifest: StableReleaseManifest,
  publicKeySpkiBase64: string
): Promise<boolean> {
  if (typeof manifest.signature !== 'string' || !/^[A-Za-z0-9_-]+$/.test(manifest.signature)) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      base64Bytes(publicKeySpkiBase64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64Bytes(manifest.signature.replaceAll('-', '+').replaceAll('_', '/')),
      new TextEncoder().encode(releaseManifestSigningPayload(manifest))
    );
  } catch {
    return false;
  }
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function installedReleaseStatus(input: {
  manifest: StableReleaseManifest | null;
  installedVersion: string | null;
  installedChannel: string | null;
  compatible: boolean;
}): InstalledReleaseStatus {
  if (!input.installedVersion || !input.manifest) return 'unknown';
  if (input.installedChannel && input.installedChannel !== 'stable') return 'development';
  const comparison = compareProductVersions(input.installedVersion, input.manifest.version);
  if (comparison === null) return 'unknown';
  if (comparison > 0) return 'newer';
  if (comparison === 0) return input.compatible ? 'latest' : 'update_required';
  if (!input.compatible) return 'update_required';
  const minimum = compareProductVersions(
    input.installedVersion,
    input.manifest.minimumSupportedVersion
  );
  return minimum !== null && minimum < 0 ? 'update_required' : 'update_available';
}

export type DownloadPlatform = 'macos-arm64' | 'windows-x64';

/**
 * Resolves the download for a platform from the signed manifest. When the
 * manifest carries no artifact, macOS falls back to the pinned release URL
 * (always downloadable), while the Windows fallback is only a predicted URL —
 * `available: false` tells the UI to keep its coming-soon treatment.
 */
export function downloadUrlForPlatform(
  manifest: StableReleaseManifest | null,
  platform: DownloadPlatform
): { url: string; available: boolean } {
  const artifact = manifest?.artifacts[platform];
  if (artifact?.url) return { url: artifact.url, available: true };
  return platform === 'windows-x64'
    ? { url: RELEASE_DOWNLOAD_URL_WINDOWS, available: false }
    : { url: RELEASE_DOWNLOAD_URL, available: true };
}

/**
 * The installer a visitor should be offered by default: the Windows build when
 * the browser reports Windows and the manifest actually ships one, otherwise
 * the Mac (Apple Silicon) build exactly as before.
 */
export function preferredDownload(manifest: StableReleaseManifest | null): {
  url: string;
  platform: DownloadPlatform;
} {
  if (currentBrowserPlatform() === 'windows') {
    const windows = downloadUrlForPlatform(manifest, 'windows-x64');
    if (windows.available) return { url: windows.url, platform: 'windows-x64' };
  }
  return { url: downloadUrlForPlatform(manifest, 'macos-arm64').url, platform: 'macos-arm64' };
}

export function macAppleSiliconDownloadUrl(manifest: StableReleaseManifest | null): string {
  return downloadUrlForPlatform(manifest, 'macos-arm64').url;
}

export function localizedReleaseSummary(
  manifest: StableReleaseManifest | null,
  language: ReleaseSummaryLanguage
): string | null {
  const summary = manifest?.summary?.[language]?.trim();
  return summary && summary.length <= 240 ? summary : null;
}

function validManifest(value: unknown): value is StableReleaseManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Partial<StableReleaseManifest>;
  return (
    source.schemaVersion === 1 &&
    source.channel === 'stable' &&
    typeof source.version === 'string' &&
    typeof source.buildNumber === 'string' &&
    typeof source.buildId === 'string' &&
    Number.isInteger(source.apiVersion) &&
    typeof source.minimumSupportedVersion === 'string' &&
    typeof source.publishedAt === 'string' &&
    validSummary(source.summary) &&
    Boolean(source.artifacts && typeof source.artifacts === 'object') &&
    Boolean(source.toolRequirements && typeof source.toolRequirements === 'object')
  );
}

function validSummary(value: StableReleaseManifest['summary'] | undefined) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([language, summary]) =>
      (language === 'en' || language === 'uk') &&
      typeof summary === 'string' &&
      summary.trim().length > 0 &&
      summary.trim().length <= 240
  );
}
