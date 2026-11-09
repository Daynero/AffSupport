import { describe, expect, it } from 'vitest';
import {
  completeManifestArtifacts,
  declaresCompletePlatformSet,
  manifestArtifactFor
} from '../scripts/lib/release/manifest-artifacts.mjs';

const base = 'https://github.com/Daynero/AffSupport/releases/download';
const urls = {
  'macos-arm64': `${base}/v1.3.4/Soty-v1.3.4-macOS-arm64.dmg`,
  'macos-x64': `${base}/v1.3.4/Soty-v1.3.4-macOS-x64.dmg`,
  'windows-x64': `${base}/v1.3.4/Soty-v1.3.4-Windows-x64.exe`
};
const twoPlatform = (version = '1.3.4') => ({
  version,
  artifacts: {
    'macos-arm64': { url: urls['macos-arm64'], sha256: 'a'.repeat(64) },
    'windows-x64': { url: urls['windows-x64'], sha256: 'c'.repeat(64) }
  }
});

describe('release manifest artifact bookkeeping (sign-release-manifest)', () => {
  it('adds a missing Intel slot as a zero placeholder, never null', () => {
    const manifest = completeManifestArtifacts(twoPlatform(), { productVersion: '1.3.4', urls });
    expect(manifest.artifacts['macos-x64']).toEqual({
      url: urls['macos-x64'],
      sha256: '0'.repeat(64)
    });
    expect(declaresCompletePlatformSet(manifest)).toBe(false);
  });

  it('refuses to add slots to an older channel unless re-signed as historical', () => {
    expect(() =>
      completeManifestArtifacts(twoPlatform('1.3.3'), { productVersion: '1.3.4', urls })
    ).toThrow(/--historical/);
    const historical = completeManifestArtifacts(twoPlatform('1.3.3'), {
      historical: true,
      productVersion: '1.3.4',
      urls
    });
    expect(Object.keys(historical.artifacts).sort()).toEqual(['macos-arm64', 'windows-x64']);
    expect(declaresCompletePlatformSet(historical)).toBe(false);
  });

  it('never lets an ARM image certify the Intel slot', () => {
    const manifest = completeManifestArtifacts(twoPlatform(), { productVersion: '1.3.4', urls });
    expect(() =>
      manifestArtifactFor(manifest, '/r/Soty-v1.3.4-macOS-arm64.dmg', 'macos-x64')
    ).toThrow(/not the macos-x64 artifact/);
    expect(() =>
      manifestArtifactFor(manifest, '/r/x64/Soty-v1.3.4-macOS-x64.dmg', 'macos-arm64')
    ).toThrow();
    expect(() => manifestArtifactFor(manifest, '/r/whatever.dmg', 'linux-x64')).toThrow(
      /Unsupported/
    );
    expect(manifestArtifactFor(manifest, '/r/x64/Soty-v1.3.4-macOS-x64.dmg', 'macos-x64')).toBe(
      manifest.artifacts['macos-x64']
    );
  });

  it('declares platform set 2 only when all three carry real digests', () => {
    const manifest = completeManifestArtifacts(twoPlatform(), { productVersion: '1.3.4', urls });
    manifest.artifacts['macos-x64'].sha256 = 'b'.repeat(64);
    expect(declaresCompletePlatformSet(manifest)).toBe(true);
    manifest.artifacts['windows-x64'].sha256 = '0'.repeat(64);
    expect(declaresCompletePlatformSet(manifest)).toBe(false);
  });
});
