import { describe, expect, it } from 'vitest';
import { installerChoices, resolveInstallerDownload } from '../apps/web/src/release-manifest';
import { RELEASE_DOWNLOAD_URL, type StableReleaseManifest } from '@video-compressor/shared';
const url = (arch: string) =>
  `https://github.com/Daynero/AffSupport/releases/download/v1.3.3/Soty-v1.3.3-macOS-${arch}.dmg`;
const manifest = {
  version: '1.3.3',
  artifacts: {
    'macos-arm64': { url: url('arm64'), sha256: 'a'.repeat(64) },
    'macos-x64': { url: url('x64'), sha256: 'b'.repeat(64) }
  }
} as StableReleaseManifest;
describe('native installer target selection', () => {
  it('selects Intel from native identity ahead of explicit browser choice', () => {
    expect(
      resolveInstallerDownload(manifest, { platform: 'macos', architecture: 'x64' }, 'macos-arm64')
    ).toMatchObject({ status: 'available', platform: 'macos-x64', url: url('x64') });
  });
  it('requires an explicit choice for legacy and unknown runtime', () => {
    expect(resolveInstallerDownload(manifest, { platform: 'macos' })).toEqual({
      status: 'choice-required'
    });
    expect(resolveInstallerDownload(manifest)).toEqual({ status: 'choice-required' });
  });
  it('never substitutes ARM for an absent or mismatched Intel asset', () => {
    expect(
      resolveInstallerDownload(
        { ...manifest, artifacts: {} },
        { platform: 'macos', architecture: 'x64' }
      )
    ).toMatchObject({ status: 'unavailable', platform: 'macos-x64' });
    expect(
      resolveInstallerDownload(
        { ...manifest, artifacts: { 'macos-x64': manifest.artifacts['macos-arm64'] } },
        { platform: 'macos', architecture: 'x64' }
      )
    ).toMatchObject({ status: 'unavailable' });
    expect(resolveInstallerDownload(null, undefined, 'macos-x64')).toMatchObject({
      status: 'unavailable'
    });
  });
  it('keeps unpublished checksum placeholders unavailable', () => {
    expect(
      resolveInstallerDownload(
        {
          ...manifest,
          artifacts: {
            ...manifest.artifacts,
            'macos-x64': { url: url('x64'), sha256: '0'.repeat(64) }
          }
        },
        { platform: 'macos', architecture: 'x64' }
      )
    ).toMatchObject({ status: 'unavailable', platform: 'macos-x64' });
  });
  it('does not migrate a package whose recorded target contradicts native runtime', () => {
    expect(
      resolveInstallerDownload(manifest, {
        platform: 'macos',
        architecture: 'arm64',
        packageTarget: 'macos-x64'
      })
    ).toMatchObject({ status: 'unavailable' });
  });
  it('keeps a known package target bound when runtime architecture is absent', () => {
    const runtime = { platform: 'macos', packageTarget: 'macos-x64' };
    // The installed package's own target selects the update, whatever the browser chose.
    for (const choice of [undefined, 'macos-arm64', 'macos-x64'] as const)
      expect(resolveInstallerDownload(manifest, runtime, choice)).toMatchObject({
        status: 'available',
        platform: 'macos-x64',
        url: url('x64')
      });
  });
  it('maps every native Windows agent, legacy or ARM64-emulated, to the x64 installer', () => {
    const windowsUrl =
      'https://github.com/Daynero/AffSupport/releases/download/v1.3.3/Soty-v1.3.3-Windows-x64.exe';
    const withWindows = {
      ...manifest,
      artifacts: {
        ...manifest.artifacts,
        'windows-x64': { url: windowsUrl, sha256: 'c'.repeat(64) }
      }
    } as StableReleaseManifest;
    for (const architecture of [undefined, 'unknown', 'x64', 'arm64'])
      expect(
        resolveInstallerDownload(withWindows, { platform: 'windows', architecture }, 'macos-x64')
      ).toMatchObject({ status: 'available', platform: 'windows-x64', url: windowsUrl });
  });
  it('keeps the pinned Apple Silicon build while the signed channel is not loaded', () => {
    expect(resolveInstallerDownload(null, undefined, 'macos-arm64')).toMatchObject({
      status: 'available',
      platform: 'macos-arm64',
      url: RELEASE_DOWNLOAD_URL
    });
    expect(resolveInstallerDownload(null, undefined, 'windows-x64')).toMatchObject({
      status: 'unavailable'
    });
    expect(
      resolveInstallerDownload(null, { platform: 'macos', architecture: 'x64' })
    ).toMatchObject({ status: 'unavailable', platform: 'macos-x64' });
  });
  it('orders unknown-target choices by host without selecting one', () => {
    expect(installerChoices(true, true)).toEqual(['macos-arm64', 'macos-x64']);
    expect(installerChoices(false, true)).toEqual(['windows-x64', 'macos-arm64', 'macos-x64']);
    expect(installerChoices(false, false)).toEqual(['macos-arm64', 'macos-x64', 'windows-x64']);
  });
  it('refuses another release even when its Intel URL is pinned', () => {
    expect(
      resolveInstallerDownload({ ...manifest, version: '1.3.4' }, undefined, 'macos-x64')
    ).toMatchObject({ status: 'unavailable' });
  });
  it('rejects unpinned artifacts', () => {
    expect(
      resolveInstallerDownload(
        {
          ...manifest,
          artifacts: {
            'macos-x64': { url: 'https://evil.example/app.dmg', sha256: 'b'.repeat(64) }
          }
        },
        undefined,
        'macos-x64'
      )
    ).toMatchObject({ status: 'unavailable' });
  });
});
