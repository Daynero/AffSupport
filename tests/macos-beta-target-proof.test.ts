import { removeTemporaryDirectory } from './support/temp-dir.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { betaPackageProvenance } from '../scripts/beta-package-provenance.mjs';
import { macosPaths } from '../scripts/lib/macos-target.mjs';

describe('architecture-bound beta package provenance', () => {
  it('keeps both seals and refuses cross-target metadata or changed bytes', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'soty-intel-proof-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim();
    try {
      git('init', '-q');
      git('config', 'user.name', 'Fixture');
      git('config', 'commit.gpgsign', 'false');
      git('config', 'core.hooksPath', path.join(cwd, '.no-hooks'));
      git('config', 'user.email', 'fixture@example.invalid');
      await writeFile(path.join(cwd, '.gitignore'), 'release/\n.env.beta\n');
      git('add', '.gitignore');
      git('commit', '-qm', 'fixture');
      const sourceRevision = git('rev-parse', 'HEAD');
      await writeFile(
        path.join(cwd, '.env.beta'),
        'VITE_SUPABASE_URL=http://127.0.0.1:54321\nAGENT_ENTITLEMENT_PUBLIC_KEY=fixture-public\n'
      );
      for (const arch of ['arm64', 'x64']) {
        const paths = macosPaths(cwd, 'beta', arch);
        const resources = path.join(paths.app, 'Contents/Resources');
        await mkdir(resources, { recursive: true });
        await mkdir(path.join(resources, 'web/dist'), { recursive: true });
        await writeFile(path.join(resources, 'web/dist/index.html'), 'fixture');
        await writeFile(
          path.join(resources, 'release.json'),
          JSON.stringify({
            sourceRevision,
            channel: 'beta',
            architecture: arch,
            target: `macos-${arch}`
          })
        );
        await betaPackageProvenance({ cwd, action: 'record', arch });
        expect(await betaPackageProvenance({ cwd, action: 'verify', arch })).toMatch(
          /^[a-f0-9]{64}$/
        );
      }
      const armSeal = await readFile(
        path.join(macosPaths(cwd, 'beta', 'arm64').root, 'package-provenance.json'),
        'utf8'
      );
      const intel = macosPaths(cwd, 'beta', 'x64');
      await writeFile(path.join(intel.root, 'package-provenance.json'), armSeal);
      await expect(betaPackageProvenance({ cwd, action: 'verify', arch: 'x64' })).rejects.toThrow(
        'PAYLOAD_CHANGED'
      );
      await betaPackageProvenance({ cwd, action: 'record', arch: 'x64' });
      await writeFile(path.join(intel.app, 'Contents/Resources/extra'), 'tampered');
      await expect(betaPackageProvenance({ cwd, action: 'verify', arch: 'x64' })).rejects.toThrow(
        'PAYLOAD_CHANGED'
      );
    } finally {
      await removeTemporaryDirectory(cwd);
    }
  });
});
