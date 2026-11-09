import {
  PRODUCTION_SITE_ORIGIN,
  RELEASE_DOWNLOAD_URL,
  REQUIRED_RELEASE_PLATFORMS,
  RELEASE_DOWNLOAD_URL_WINDOWS,
  RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64,
  compareProductVersions,
  isPinnedReleaseArtifact,
  releaseManifestSigningPayload,
  releaseArtifactName,
  type ReleaseSummaryLanguage,
  type AppEnvironment,
  type StableReleaseManifest
} from '@video-compressor/shared';
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

export type DownloadPlatform = 'macos-arm64' | 'macos-x64' | 'windows-x64';

export type InstallerDownload =
  | { status: 'choice-required' }
  | { status: 'unavailable'; platform: DownloadPlatform }
  | { status: 'available'; platform: DownloadPlatform; url: string };

/** Input manifest is authenticated by loadStableReleaseManifest; native identity wins. */
export function resolveInstallerDownload(
  manifest: StableReleaseManifest | null,
  runtime?: {
    platform?: string | null;
    architecture?: string | null;
    packageTarget?: string | null;
  },
  choice?: DownloadPlatform
): InstallerDownload {
  let platform = choice;
  if (
    runtime?.platform === 'macos' &&
    (runtime.architecture === 'x64' || runtime.architecture === 'arm64')
  ) {
    platform = runtime.architecture === 'x64' ? 'macos-x64' : 'macos-arm64';
  } else if (
    runtime?.platform === 'macos' &&
    (runtime.packageTarget === 'macos-x64' || runtime.packageTarget === 'macos-arm64')
  ) {
    // The installed package names its own target even when the runtime CPU is unreported.
    platform = runtime.packageTarget;
  } else if (runtime?.platform === 'windows') {
    // Windows ships one x64 installer; ARM64 Windows runs it under emulation, and an
    // agent older than 049 reports no architecture at all.
    platform = 'windows-x64';
  }
  if (!platform) return { status: 'choice-required' };
  if (
    runtime?.packageTarget &&
    runtime.packageTarget !== 'unknown' &&
    runtime.packageTarget !== platform
  )
    return { status: 'unavailable', platform };
  const artifact = manifest?.artifacts[platform];
  const expected = manifest
    ? `/v${manifest.version}/${releaseArtifactName(platform, manifest.version)}`
    : null;
  if (!manifest && platform === 'macos-arm64')
    // Unchanged pre-049 behaviour: while the signed channel is loading, unreachable or
    // (beta) never consulted, Apple Silicon keeps the release pinned into this web build.
    // Intel and Windows stay unavailable rather than guessing an unverified asset.
    return { status: 'available', platform, url: RELEASE_DOWNLOAD_URL };
  const legacyArm =
    platform === 'macos-arm64' && manifest
      ? `/v${manifest.version}/Soty-v${manifest.version}.dmg`
      : null;
  if (
    !isPinnedReleaseArtifact(artifact) ||
    /^0+$/u.test(artifact.sha256) ||
    !expected ||
    !(artifact.url.endsWith(expected) || (legacyArm && artifact.url.endsWith(legacyArm)))
  )
    return { status: 'unavailable', platform };
  return { status: 'available', platform, url: artifact.url };
}

/**
 * Processor choices when the native target is unknown. A connected Mac agent
 * (even a legacy one without architecture) rules Windows out; the browser's
 * platform only orders the options, it never selects one.
 */
export function installerChoices(nativeMac: boolean, browserWindows: boolean): DownloadPlatform[] {
  if (nativeMac) return ['macos-arm64', 'macos-x64'];
  return browserWindows
    ? ['windows-x64', 'macos-arm64', 'macos-x64']
    : ['macos-arm64', 'macos-x64', 'windows-x64'];
}

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
  // Checked again here, not only at load: a manifest can reach this function from somewhere
  // other than `loadStableReleaseManifest`, and an unpinned URL must never become a link.
  if (platform === 'macos-x64') {
    const result = resolveInstallerDownload(manifest, undefined, platform);
    return {
      url: result.status === 'available' ? result.url : '',
      available: result.status === 'available'
    };
  }
  if (isPinnedReleaseArtifact(artifact)) return { url: artifact.url, available: true };
  return platform === 'windows-x64'
    ? { url: RELEASE_DOWNLOAD_URL_WINDOWS, available: false }
    : { url: RELEASE_DOWNLOAD_URL, available: true };
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
    (source.platformSetVersion === undefined ||
      (source.platformSetVersion === 2 &&
        REQUIRED_RELEASE_PLATFORMS.every(platform =>
          isPinnedReleaseArtifact(source.artifacts?.[platform])
        ))) &&
    typeof source.version === 'string' &&
    typeof source.buildNumber === 'string' &&
    typeof source.buildId === 'string' &&
    Number.isInteger(source.apiVersion) &&
    typeof source.minimumSupportedVersion === 'string' &&
    typeof source.publishedAt === 'string' &&
    validSummary(source.summary) &&
    validArtifacts(source.artifacts) &&
    Boolean(source.toolRequirements && typeof source.toolRequirements === 'object')
  );
}

/**
 * Every artifact must name the pinned download origin and a well-formed sha256 (C11).
 *
 * One bad entry refuses the whole manifest rather than just that platform: a correctly signed
 * manifest pointing anywhere else means the signing key was misused, and nothing else that
 * manifest says can be trusted either.
 */
function validArtifacts(value: StableReleaseManifest['artifacts'] | undefined) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(isPinnedReleaseArtifact);
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
