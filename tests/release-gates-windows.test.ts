import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RELEASE_ARTIFACT_NAME_WINDOWS,
  RELEASE_DOWNLOAD_URL,
  RELEASE_DOWNLOAD_URLS,
  RELEASE_DOWNLOAD_URL_WINDOWS,
  RELEASE_TAG,
  REQUIRED_RELEASE_PLATFORMS,
  type ReleasePlatform,
  type StableReleaseManifest
} from '../packages/shared/src/release.js';

/**
 * Mirrors the artifact rules in scripts/verify-release.mjs. The script itself
 * calls process.exit on failure, so the rules are re-expressed here as a pure
 * predicate the tests can drive with crafted manifests.
 */
function artifactFailures(
  manifest: Pick<StableReleaseManifest, 'artifacts'>,
  required: readonly ReleasePlatform[] = REQUIRED_RELEASE_PLATFORMS
): string[] {
  const failures: string[] = [];
  for (const platform of required) {
    const artifact = manifest.artifacts?.[platform];
    if (!artifact) {
      failures.push(`missing required ${platform} artifact`);
      continue;
    }
    const expected = RELEASE_DOWNLOAD_URLS[platform];
    if (expected && artifact.url !== expected) {
      failures.push(`${platform} artifact does not point at the immutable release`);
    }
  }
  for (const [platform, artifact] of Object.entries(manifest.artifacts ?? {})) {
    if (!['macos-arm64', 'macos-x64', 'windows-x64'].includes(platform)) {
      failures.push(`unsupported platform ${platform}`);
    }
    if (!artifact?.url?.startsWith('https://') || !/^[a-f0-9]{64}$/u.test(artifact?.sha256 ?? '')) {
      failures.push(`${platform} artifact is incomplete`);
    }
  }
  return failures;
}

const SHA = 'a'.repeat(64);
const macArtifact = { url: RELEASE_DOWNLOAD_URL, sha256: SHA };
const windowsArtifact = { url: RELEASE_DOWNLOAD_URL_WINDOWS, sha256: SHA };
const BOTH_REQUIRED: readonly ReleasePlatform[] = ['macos-arm64', 'windows-x64'];

describe('windows artifact naming derives from the release identity', () => {
  it('names the installer and its URL from the tag, never by hand', () => {
    expect(RELEASE_ARTIFACT_NAME_WINDOWS).toContain(RELEASE_TAG);
    expect(RELEASE_DOWNLOAD_URL_WINDOWS).toBe(
      `https://github.com/Daynero/AffSupport/releases/download/` +
        `${RELEASE_TAG}/${RELEASE_ARTIFACT_NAME_WINDOWS}`
    );
  });

  it('exposes a download URL for every platform a release can require', () => {
    for (const platform of BOTH_REQUIRED) {
      expect(RELEASE_DOWNLOAD_URLS[platform]).toMatch(/^https:\/\//u);
    }
  });
});

describe('release gate with Windows required', () => {
  it('accepts a complete two-platform manifest', () => {
    const failures = artifactFailures(
      { artifacts: { 'macos-arm64': macArtifact, 'windows-x64': windowsArtifact } },
      BOTH_REQUIRED
    );
    expect(failures).toEqual([]);
  });

  it('blocks a release that ships macOS alone', () => {
    const failures = artifactFailures({ artifacts: { 'macos-arm64': macArtifact } }, BOTH_REQUIRED);
    expect(failures).toContain('missing required windows-x64 artifact');
  });

  it('blocks a Windows URL that is not the immutable release artifact', () => {
    const failures = artifactFailures(
      {
        artifacts: {
          'macos-arm64': macArtifact,
          'windows-x64': { url: 'https://example.com/soty.exe', sha256: SHA }
        }
      },
      BOTH_REQUIRED
    );
    expect(failures).toContain('windows-x64 artifact does not point at the immutable release');
  });

  it('blocks a Windows artifact with a missing or malformed checksum', () => {
    for (const sha256 of [null, '', 'abc123']) {
      const failures = artifactFailures(
        {
          artifacts: {
            'macos-arm64': macArtifact,
            'windows-x64': { url: RELEASE_DOWNLOAD_URL_WINDOWS, sha256 }
          }
        },
        BOTH_REQUIRED
      );
      expect(failures).toContain('windows-x64 artifact is incomplete');
    }
  });
});

describe('current required-platform set', () => {
  it('still gates on macOS', () => {
    expect(REQUIRED_RELEASE_PLATFORMS).toContain('macos-arm64');
  });

  it('matches the published stable manifest, so release:check passes today', () => {
    const manifest = JSON.parse(
      readFileSync('apps/web/public/.well-known/wishly/stable.json', 'utf8')
    ) as Pick<StableReleaseManifest, 'artifacts'>;
    expect(artifactFailures(manifest)).toEqual([]);
  });

  it('flipping Windows on is what makes it block a release', () => {
    const manifest = JSON.parse(
      readFileSync('apps/web/public/.well-known/wishly/stable.json', 'utf8')
    ) as Pick<StableReleaseManifest, 'artifacts'>;
    const windowsPublished = Boolean(manifest.artifacts?.['windows-x64']);
    // Until the Windows installer is published, requiring it must fail — that is
    // exactly why REQUIRED_RELEASE_PLATFORMS is flipped last in the rollout.
    expect(artifactFailures(manifest, BOTH_REQUIRED).length === 0).toBe(windowsPublished);
  });
});
