import { removeTemporaryDirectory } from './support/temp-dir.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPackageTarget } from '../apps/agent/src/server/package-identity';

describe('installed package identity', () => {
  it('keeps Windows package identity independent of the macOS default', () => {
    const metadata = JSON.parse(
      execFileSync(
        process.execPath,
        ['scripts/release-meta.mjs', '--json', 'a'.repeat(40), '--platform=windows-x64'],
        { encoding: 'utf8' }
      )
    );
    expect(metadata).toMatchObject({ target: 'windows-x64', architecture: 'x64' });
    expect(metadata.artifact).toMatch(/-Windows-x64\.exe$/u);
  });
  it('reads exact build metadata and keeps absent/legacy/wrong-build target unknown', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-package-identity-'));
    const installedReleasePath = path.join(directory, 'release.json');
    const config = { installedReleasePath, buildId: '1.3.3+79' };
    try {
      expect(await readPackageTarget(config)).toBe('unknown');
      await writeFile(
        installedReleasePath,
        JSON.stringify({ buildId: config.buildId, target: 'macos-x64' })
      );
      expect(await readPackageTarget(config)).toBe('macos-x64');
      await writeFile(
        installedReleasePath,
        JSON.stringify({ buildId: 'other', target: 'macos-x64' })
      );
      expect(await readPackageTarget(config)).toBe('unknown');
      await writeFile(installedReleasePath, JSON.stringify({ buildId: config.buildId }));
      expect(await readPackageTarget(config)).toBe('unknown');
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });
});
