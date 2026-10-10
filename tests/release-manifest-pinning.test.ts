import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RELEASE_ARTIFACT_ORIGIN,
  RELEASE_ARTIFACT_PATH_PREFIX,
  RELEASE_DOWNLOAD_URL,
  RELEASE_DOWNLOAD_URL_WINDOWS,
  RELEASE_DOWNLOAD_URLS,
  isPinnedReleaseArtifact,
  releaseManifestSigningPayload,
  type ReleaseArtifact,
  type StableReleaseManifest
} from '../packages/shared/src/release.js';
import {
  downloadUrlForPlatform,
  loadStableReleaseManifest
} from '../apps/web/src/release-manifest.js';

/**
 * C11 (FR-028). A correctly signed manifest is still refused when it points an artifact at an
 * unexpected host or carries a malformed hash.
 *
 * The signature proves who wrote stable.json; before this, nothing constrained what they
 * wrote — `downloadUrlForPlatform` returned `artifact.url` verbatim and the manifest check
 * looked at neither the origin nor the digest. One misused signing key therefore yielded an
 * arbitrary download origin for every user. Every manifest below is **validly signed** by a
 * test key, so a refusal can only come from the pinning, never from the signature.
 */

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const PINNED = `${RELEASE_ARTIFACT_ORIGIN}${RELEASE_ARTIFACT_PATH_PREFIX}v9.9.9/Soty-v9.9.9-macOS-arm64.dmg`;
const DIGEST = 'a'.repeat(64);

function manifestWith(artifacts: Record<string, unknown>): StableReleaseManifest {
  const unsigned = {
    schemaVersion: 1,
    channel: 'stable',
    version: '9.9.9',
    buildNumber: '999',
    buildId: '9.9.9+999',
    apiVersion: 5,
    minimumSupportedVersion: '0.4.0',
    publishedAt: '2026-10-10T00:00:00.000Z',
    artifacts,
    toolRequirements: {}
  } as unknown as StableReleaseManifest;
  const signature = signBytes('sha256', Buffer.from(releaseManifestSigningPayload(unsigned)), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return { ...unsigned, signature };
}

function load(manifest: StableReleaseManifest) {
  const fetcher = (async () =>
    new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch;
  return loadStableReleaseManifest(fetcher, publicKeyBase64, 'production');
}

const HOSTILE_URLS: readonly [string, string][] = [
  ['another host', 'https://evil.example/Soty.dmg'],
  [
    'a lookalike host that starts with the real one',
    'https://github.com.evil.example/Daynero/AffSupport/releases/download/v9.9.9/Soty.dmg'
  ],
  [
    'credentials that make the real host a username',
    'https://github.com@evil.example/Daynero/AffSupport/releases/download/v9.9.9/Soty.dmg'
  ],
  [
    'a username in front of the real host',
    'https://attacker@github.com/Daynero/AffSupport/releases/download/v9.9.9/Soty.dmg'
  ],
  ['plain http', 'http://github.com/Daynero/AffSupport/releases/download/v9.9.9/Soty.dmg'],
  [
    'an explicit port',
    'https://github.com:8443/Daynero/AffSupport/releases/download/v9.9.9/Soty.dmg'
  ],
  [
    'another repository on the right host',
    'https://github.com/attacker/AffSupport/releases/download/v9.9.9/Soty.dmg'
  ],
  [
    'a release page instead of a download',
    'https://github.com/Daynero/AffSupport/releases/tag/v9.9.9'
  ],
  [
    'traversal out of the release directory',
    'https://github.com/Daynero/AffSupport/releases/download/../../../attacker/repo/releases/download/v1/Soty.dmg'
  ],
  [
    'encoded traversal',
    'https://github.com/Daynero/AffSupport/releases/download/%2e%2e/%2e%2e/attacker/Soty.dmg'
  ],
  [
    'a backslash the URL parser rewrites',
    'https://github.com\\@evil.example/Daynero/AffSupport/releases/download/v9.9.9/Soty.dmg'
  ],
  ['a query string', `${PINNED}?redirect=https://evil.example`],
  ['a fragment', `${PINNED}#x`],
  [
    'a nested directory under the tag',
    'https://github.com/Daynero/AffSupport/releases/download/v9.9.9/extra/Soty.dmg'
  ],
  ['a javascript URL', 'javascript:alert(1)'],
  ['a protocol-relative URL', '//evil.example/Soty.dmg'],
  ['an empty URL', '']
];

const HOSTILE_DIGESTS: readonly [string, unknown][] = [
  ['no digest at all', null],
  ['a missing digest', undefined],
  ['one character short', 'a'.repeat(63)],
  ['one character long', 'a'.repeat(65)],
  ['uppercase hex', 'A'.repeat(64)],
  ['not hex', 'g'.repeat(64)],
  ['a digest with whitespace', ` ${'a'.repeat(64)}`],
  ['a number', 1234],
  ['an algorithm prefix', `sha256:${'a'.repeat(57)}`]
];

describe('an artifact on an unexpected host is refused', () => {
  it.each(HOSTILE_URLS)('refuses %s', async (_why, url) => {
    expect(isPinnedReleaseArtifact({ url, sha256: DIGEST })).toBe(false);
    await expect(load(manifestWith({ 'macos-arm64': { url, sha256: DIGEST } }))).rejects.toThrow(
      'RELEASE_MANIFEST_INVALID'
    );
  });
});

describe('an artifact with a malformed hash is refused', () => {
  it.each(HOSTILE_DIGESTS)('refuses %s', async (_why, sha256) => {
    const artifact = { url: PINNED, ...(sha256 === undefined ? {} : { sha256 }) };
    expect(isPinnedReleaseArtifact(artifact)).toBe(false);
    await expect(load(manifestWith({ 'macos-arm64': artifact }))).rejects.toThrow(
      'RELEASE_MANIFEST_INVALID'
    );
  });
});

describe('one bad artifact refuses the whole manifest', () => {
  it('does not keep the good platform when the other one is unpinned', async () => {
    // A signed manifest pointing anywhere else means the key was misused; nothing else it
    // says is trustworthy either.
    const manifest = manifestWith({
      'macos-arm64': { url: PINNED, sha256: DIGEST },
      'windows-x64': { url: 'https://evil.example/Soty.exe', sha256: DIGEST }
    });
    await expect(load(manifest)).rejects.toThrow('RELEASE_MANIFEST_INVALID');
  });

  it('refuses an artifacts field that is not an object of artifacts', async () => {
    await expect(load(manifestWith({ 'macos-arm64': 'https://evil.example' }))).rejects.toThrow(
      'RELEASE_MANIFEST_INVALID'
    );
  });
});

describe('the download link never leaves the pinned origin', () => {
  it('falls back to the pinned release URL when a manifest reaches it unvalidated', () => {
    // Defence in depth: `downloadUrlForPlatform` is exported and takes any manifest.
    const hostile = {
      artifacts: { 'macos-arm64': { url: 'https://evil.example/Soty.dmg', sha256: DIGEST } }
    } as unknown as StableReleaseManifest;
    expect(downloadUrlForPlatform(hostile, 'macos-arm64')).toEqual({
      url: RELEASE_DOWNLOAD_URL,
      available: true
    });
    const windows = {
      artifacts: { 'windows-x64': { url: 'https://evil.example/Soty.exe', sha256: DIGEST } }
    } as unknown as StableReleaseManifest;
    expect(downloadUrlForPlatform(windows, 'windows-x64')).toEqual({
      url: RELEASE_DOWNLOAD_URL_WINDOWS,
      available: false
    });
  });
});

describe('the legitimate manifest still loads', () => {
  it('accepts a signed manifest on the pinned origin', async () => {
    const manifest = manifestWith({ 'macos-arm64': { url: PINNED, sha256: DIGEST } });
    await expect(load(manifest)).resolves.toMatchObject({ version: '9.9.9' });
    expect(downloadUrlForPlatform(manifest, 'macos-arm64')).toEqual({
      url: PINNED,
      available: true
    });
  });

  it('pins every URL the release itself derives', () => {
    for (const url of [
      RELEASE_DOWNLOAD_URL,
      RELEASE_DOWNLOAD_URL_WINDOWS,
      ...Object.values(RELEASE_DOWNLOAD_URLS)
    ]) {
      expect(isPinnedReleaseArtifact({ url, sha256: DIGEST }), url).toBe(true);
    }
  });

  it('pins every artifact of the published stable.json', () => {
    // If this fails, the live manifest would be refused by every client after deploy.
    const published = JSON.parse(
      readFileSync('apps/web/public/.well-known/wishly/stable.json', 'utf8')
    ) as { artifacts: Record<string, ReleaseArtifact> };
    const artifacts = Object.entries(published.artifacts);
    expect(artifacts.length).toBeGreaterThan(0);
    for (const [platform, artifact] of artifacts) {
      expect(isPinnedReleaseArtifact(artifact), platform).toBe(true);
    }
  });
});
