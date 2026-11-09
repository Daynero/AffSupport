import { removeTemporaryDirectory } from './support/temp-dir.js';
import { describeRequiring, requirePlatform } from './support/requires.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateMachOInspection, verifyMacosPayload } from '../scripts/lib/macos-payload.mjs';

const valid = {
  platforms: ['1'],
  slices: ['x86_64'],
  minimums: ['13.0'],
  dependencies: ['/usr/lib/libSystem.B.dylib'],
  rpaths: []
};
describe('recursive macOS payload compatibility', () => {
  it('accepts requested slices and older deployment targets', () => {
    expect(() => validateMachOInspection({ ...valid, minimums: ['11.0'] }, 'x64')).not.toThrow();
    expect(() =>
      validateMachOInspection({ ...valid, slices: ['arm64', 'x86_64'] }, 'x64')
    ).not.toThrow();
  });
  it('refuses a foreign Apple platform despite a matching CPU and deployment number', () => {
    expect(() => validateMachOInspection({ ...valid, platforms: ['7'] }, 'x64')).toThrow(
      'PLATFORM'
    );
    expect(() => validateMachOInspection({ ...valid, platforms: [] }, 'x64')).toThrow('PLATFORM');
  });
  it('rejects a browser/helper or engine from the build host', () => {
    expect(() => validateMachOInspection({ ...valid, slices: ['arm64'] }, 'x64')).toThrow('ARCH');
  });
  it('rejects absent or too new deployment evidence', () => {
    expect(() => validateMachOInspection({ ...valid, minimums: ['14.0'] }, 'x64')).toThrow('OS');
    expect(() => validateMachOInspection({ ...valid, minimums: [] }, 'x64')).toThrow('OS');
  });
  it('refuses nonportable dependencies and unsafe runtime search paths', () => {
    expect(() =>
      validateMachOInspection({ ...valid, dependencies: ['/usr/local/lib/libfoo.dylib'] }, 'x64')
    ).toThrow('DEPENDENCY');
    expect(() =>
      validateMachOInspection(
        { ...valid, dependencies: ['/usr/lib/../../opt/homebrew/libfoo.dylib'] },
        'x64'
      )
    ).toThrow('DEPENDENCY');
    expect(() =>
      validateMachOInspection({ ...valid, rpaths: ['/System/Library/../../opt/local'] }, 'x64')
    ).toThrow('RPATH');
    expect(() =>
      validateMachOInspection({ ...valid, rpaths: ['/opt/homebrew/lib'] }, 'x64')
    ).toThrow('RPATH');
  });
});

// Real cross-compiled Mach-O fixtures prove the load-command parser, not just its validator.
describeRequiring(requirePlatform('darwin'), 'native payload inspection fixtures', () => {
  it('inspects actual target slices and deployment load commands without executing them', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-macho-'));
    try {
      const source = path.join(directory, 'fixture.c');
      const library = path.join(directory, 'fixture.dylib');
      await writeFile(source, 'int fixture(void) { return 0; }\n');
      const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
        encoding: 'utf8'
      }).trim();
      execFileSync('xcrun', [
        'clang',
        '-target',
        'x86_64-apple-macos13.0',
        '-isysroot',
        sdk,
        '-dynamiclib',
        source,
        '-o',
        library
      ]);
      expect(await verifyMacosPayload(directory, 'x64')).toMatchObject({
        target: 'macos-x64',
        nativeFileCount: 1,
        staticOnly: true
      });
      const foreignAddon = path.join(directory, 'foreign.node');
      await writeFile(foreignAddon, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      await expect(verifyMacosPayload(directory, 'x64')).rejects.toThrow('NATIVE_MODULE_INVALID');
      await rm(foreignAddon);
      await expect(verifyMacosPayload(directory, 'arm64')).rejects.toThrow();
      execFileSync('xcrun', [
        'clang',
        '-target',
        'x86_64-apple-macos13.0',
        '-isysroot',
        sdk,
        '-dynamiclib',
        source,
        '-Wl,-rpath,@loader_path/../../outside',
        '-o',
        library
      ]);
      await expect(verifyMacosPayload(directory, 'x64')).rejects.toThrow('RPATH_EXTERNAL');
      execFileSync('xcrun', [
        'clang',
        '-target',
        'x86_64-apple-macos14.0',
        '-isysroot',
        sdk,
        '-dynamiclib',
        source,
        '-o',
        library
      ]);
      await expect(verifyMacosPayload(directory, 'x64')).rejects.toThrow('OS_UNSUPPORTED');
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });
});
