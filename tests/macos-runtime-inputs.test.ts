import { removeTemporaryDirectory } from './support/temp-dir.js';
import { describeRequiring, requirePlatform } from './support/requires.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, stat, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stageMacosInputs, verifyMacosInputs } from '../scripts/stage-macos-inputs.mjs';

describe('first Intel runtime bootstrap', () => {
  it('validates architecture, complete provenance and digests before creating outputs', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'soty-runtime-input-'));
    try {
      const manifest = { schemaVersion: 1, architecture: 'x64', cpuBaseline: 'x86-64', files: {} };
      await expect(stageMacosInputs({ cwd, arch: 'arm64', manifest })).rejects.toThrow(
        'MANIFEST_INVALID'
      );
      await expect(stageMacosInputs({ cwd, arch: 'x64', manifest })).rejects.toThrow(
        'INPUT_INVALID'
      );
      const binary = path.join(cwd, 'node');
      await writeFile(binary, 'fixture');
      const node = {
        path: binary,
        sha256: 'a'.repeat(64),
        version: '22.23.2',
        source: 'https://nodejs.org/dist/',
        license: 'MIT'
      };
      await expect(
        stageMacosInputs({ cwd, arch: 'x64', manifest: { ...manifest, files: { node } } })
      ).rejects.toThrow('DIGEST_MISMATCH');
      node.sha256 = createHash('sha256').update('fixture').digest('hex');
      await expect(
        stageMacosInputs({ cwd, arch: 'x64', manifest: { ...manifest, files: { node } } })
      ).rejects.toThrow('INPUT_INVALID');
      expect(await stat(path.join(cwd, 'release')).catch(() => null)).toBeNull();
    } finally {
      await removeTemporaryDirectory(cwd);
    }
  });
});

describeRequiring(requirePlatform('darwin'), 'static bootstrap fixtures', () => {
  // Cold xcrun/clang plus repeated payload inspection exceeds the generic 5s
  // unit deadline on hosted Macs. This is a hang watchdog, not a timing assertion.
  it('seals fixed destinations without source paths and refuses tampered bytes or replacement', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'soty-runtime-stage-'));
    try {
      const source = path.join(cwd, 'fixture.c');
      const binary = path.join(cwd, 'fixture');
      const neutral = path.join(cwd, 'neutral');
      await writeFile(source, 'int main(void) { return 0; }\n');
      await writeFile(neutral, 'public fixture');
      const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
        encoding: 'utf8'
      }).trim();
      execFileSync('xcrun', [
        'clang',
        '-target',
        'x86_64-apple-macos13.0',
        '-isysroot',
        sdk,
        source,
        '-o',
        binary
      ]);
      const files = Object.fromEntries(
        await Promise.all(
          ['node', 'ffmpeg', 'ffprobe', 'whisper', 'vad', 'ffmpegSource', 'x264Source'].map(
            async key => {
              const input = ['node', 'ffmpeg', 'ffprobe', 'whisper'].includes(key)
                ? binary
                : neutral;
              return [
                key,
                {
                  path: input,
                  sha256: createHash('sha256')
                    .update(await readFile(input))
                    .digest('hex'),
                  version: 'fixture',
                  source: 'https://example.org/fixture',
                  license: 'MIT'
                }
              ];
            }
          )
        )
      );
      const manifest = { schemaVersion: 1, architecture: 'x64', cpuBaseline: 'x86-64', files };
      await expect(
        stageMacosInputs({
          cwd: path.join(cwd, 'invalid-node'),
          arch: 'x64',
          manifest: {
            ...manifest,
            files: {
              ...files,
              node: {
                path: neutral,
                sha256: createHash('sha256')
                  .update(await readFile(neutral))
                  .digest('hex'),
                version: 'fixture',
                source: 'https://example.invalid/fixture',
                license: 'MIT'
              }
            }
          }
        })
      ).rejects.toThrow('NATIVE_INVALID');
      const root = await stageMacosInputs({ cwd, arch: 'x64', manifest });
      expect(await verifyMacosInputs(root, 'x64')).toMatchObject({
        target: 'macos-x64',
        staticOnly: true
      });
      const bindings = Object.fromEntries(
        Object.keys(files).map(key => [
          key,
          ['node', 'ffmpeg', 'ffprobe', 'whisper'].includes(key) ? binary : neutral
        ])
      );
      expect(await verifyMacosInputs(root, 'x64', bindings)).toMatchObject({ staticOnly: true });
      await expect(verifyMacosInputs(root, 'x64', { ...bindings, node: neutral })).rejects.toThrow(
        'BINDING_MISMATCH'
      );
      expect(await readFile(path.join(root, 'approved-inputs.json'), 'utf8')).not.toContain(cwd);
      await writeFile(path.join(root, 'Contents/Resources/runtime/node'), 'tampered');
      await expect(verifyMacosInputs(root, 'x64')).rejects.toThrow('DIGEST_MISMATCH');
      await expect(stageMacosInputs({ cwd, arch: 'x64', manifest })).rejects.toThrow(
        'DESTINATION_EXISTS'
      );
    } finally {
      await removeTemporaryDirectory(cwd);
    }
  }, 30_000);
});
