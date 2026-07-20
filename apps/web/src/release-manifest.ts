import {
  PRODUCTION_SITE_ORIGIN,
  compareProductVersions,
  type ReleaseArtifact,
  type ReleasePlatform,
  type StableReleaseManifest
} from '@video-compressor/shared';

export type ReleaseManifestState =
  | { status: 'checking'; manifest: null }
  | { status: 'unavailable'; manifest: null }
  | { status: 'ready'; manifest: StableReleaseManifest };

export type InstalledReleaseStatus =
  'unknown' | 'latest' | 'update_available' | 'update_required' | 'development' | 'newer';

export const RELEASE_MANIFEST_URL = `${PRODUCTION_SITE_ORIGIN}/.well-known/wishly/stable.json`;

export async function loadStableReleaseManifest(
  fetcher: typeof fetch = fetch
): Promise<StableReleaseManifest> {
  const response = await fetcher(RELEASE_MANIFEST_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`RELEASE_MANIFEST_${response.status}`);
  const value = (await response.json()) as unknown;
  if (!validManifest(value)) throw new Error('RELEASE_MANIFEST_INVALID');
  return value;
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

export function releaseArtifact(
  manifest: StableReleaseManifest | null,
  platform: 'macos' | 'windows' | 'linux' | 'other',
  architecture = browserArchitecture()
): ReleaseArtifact | null {
  if (!manifest) return null;
  const key: ReleasePlatform | null =
    platform === 'macos'
      ? architecture === 'x64'
        ? 'macos-x64'
        : 'macos-arm64'
      : platform === 'windows'
        ? 'windows-x64'
        : null;
  return key ? (manifest.artifacts[key] ?? null) : null;
}

function browserArchitecture(): 'arm64' | 'x64' {
  const source = typeof navigator === 'undefined' ? '' : navigator.userAgent.toLowerCase();
  return /arm64|aarch64/.test(source) ? 'arm64' : 'x64';
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
    Boolean(source.artifacts && typeof source.artifacts === 'object') &&
    Boolean(source.toolRequirements && typeof source.toolRequirements === 'object')
  );
}
