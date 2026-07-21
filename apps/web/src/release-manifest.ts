import {
  PRODUCTION_SITE_ORIGIN,
  RELEASE_DOWNLOAD_URL,
  compareProductVersions,
  type ReleaseSummaryLanguage,
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

export function macAppleSiliconDownloadUrl(manifest: StableReleaseManifest | null): string {
  return manifest?.artifacts['macos-arm64']?.url ?? RELEASE_DOWNLOAD_URL;
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
