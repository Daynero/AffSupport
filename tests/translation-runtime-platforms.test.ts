import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TRANSLATION_RUNTIME_DESCRIPTOR,
  TRANSLATION_RUNTIME_DESCRIPTORS,
  selectTranslationRuntimeDescriptor
} from '../apps/agent/src/translation/tools.js';
import { ModelDownloader } from '../apps/agent/src/whisper/downloader.js';

describe('per-platform llama.cpp runtime descriptors', () => {
  it('selects the pinned Apple Silicon build for darwin-arm64', () => {
    const descriptor = selectTranslationRuntimeDescriptor('darwin', 'arm64');
    expect(descriptor).toBe(TRANSLATION_RUNTIME_DESCRIPTORS['darwin-arm64']);
    expect(descriptor).toMatchObject({
      tag: 'b10092',
      archiveName: 'llama-b10092-bin-macos-arm64.tar.gz',
      archiveKind: 'tar.gz',
      extractedDirectory: 'llama-b10092',
      executableName: 'llama-server',
      sha256: 'f3ec2351e06322478e3f38f23f5339cd834cca5e3740f334ce2bdc5de95f90e0',
      sizeBytes: 10_612_780
    });
  });

  it('selects the pinned official Windows x64 CPU zip for win32-x64', () => {
    const descriptor = selectTranslationRuntimeDescriptor('win32', 'x64');
    expect(descriptor).toBe(TRANSLATION_RUNTIME_DESCRIPTORS['win32-x64']);
    expect(descriptor).toMatchObject({
      tag: 'b10092',
      archiveName: 'llama-b10092-bin-win-cpu-x64.zip',
      archiveKind: 'zip',
      // Windows release zips are flat: llama-server.exe sits at the root.
      extractedDirectory: null,
      executableName: 'llama-server',
      sha256: 'c842fa7dc90e32b327c62903f4310ef251a902c90ef5b3a6c01c6b675dce078e',
      sizeBytes: 18_021_876
    });
    expect(descriptor?.url).toBe(
      'https://github.com/ggml-org/llama.cpp/releases/download/b10092/' +
        'llama-b10092-bin-win-cpu-x64.zip'
    );
  });

  it('pins every supported platform to a complete checksum so translation can install', () => {
    for (const [key, descriptor] of Object.entries(TRANSLATION_RUNTIME_DESCRIPTORS)) {
      expect(descriptor.sha256, `${key} must pin a sha256`).toMatch(/^[a-f0-9]{64}$/u);
      expect(descriptor.sizeBytes, `${key} must pin a positive size`).toBeGreaterThan(0);
    }
  });

  it('pins both platforms to the same upstream tag and revision', () => {
    const mac = TRANSLATION_RUNTIME_DESCRIPTORS['darwin-arm64'];
    const windows = TRANSLATION_RUNTIME_DESCRIPTORS['win32-x64'];
    expect(windows.tag).toBe(mac.tag);
    expect(windows.revision).toBe(mac.revision);
  });

  it('returns null for unsupported platform/arch pairs', () => {
    expect(selectTranslationRuntimeDescriptor('darwin', 'x64')).toBeNull();
    expect(selectTranslationRuntimeDescriptor('win32', 'arm64')).toBeNull();
    expect(selectTranslationRuntimeDescriptor('linux', 'x64')).toBeNull();
  });

  it('exposes a descriptor for the current process (macOS fallback elsewhere)', () => {
    const expected =
      selectTranslationRuntimeDescriptor() ?? TRANSLATION_RUNTIME_DESCRIPTORS['darwin-arm64'];
    expect(TRANSLATION_RUNTIME_DESCRIPTOR).toBe(expected);
  });
});

describe('downloader refusal for unpinned checksums', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Every shipped descriptor is pinned (asserted above), so the refusal path is
  // exercised through a synthetic descriptor. It stays covered because an
  // unpinned runtime must never reach the network on a future platform.
  const unpinned = {
    ...TRANSLATION_RUNTIME_DESCRIPTORS['win32-x64'],
    label: 'llama.cpp b10092 (Windows x64, CPU)',
    sha256: null,
    sizeBytes: 0
  };

  it('refuses to download when sha256 is null instead of fetching unverifiable bytes', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network must not be touched');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const notify = vi.fn();
    const downloader = new ModelDownloader(
      unpinned,
      () => path.join(os.tmpdir(), 'wishly-test-never-written.zip'),
      () => false,
      notify,
      () => {}
    );

    await downloader.start();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(downloader.status().downloading).toBe(false);
    expect(downloader.status().error).toBe(
      'The llama.cpp b10092 (Windows x64, CPU) checksum is not pinned for this platform yet.'
    );
    expect(notify).toHaveBeenCalled();
  });
});
