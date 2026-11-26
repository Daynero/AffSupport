import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect } from 'vitest';
import {
  developerIdRequirement,
  verifyNativeCandidateBundle
} from '../apps/agent/src/update/candidate-identity';
import { nativeCandidate } from './support/native-app-updates';
import { itRequiring, requirePlatform } from './support/requires.js';
import { removeTemporaryDirectory } from './support/temp-dir';

/**
 * 1.7.0 qualification, 2026-11-26: an ad-hoc bundle carrying a valid EdDSA signature and a
 * descriptor naming the right team replaced the app and ran. Sparkle accepts a changed
 * signing identity when EdDSA verifies, so the candidate's own Developer ID is proven first.
 */
const itPosix = itRequiring.bind(null, requirePlatform('darwin', 'linux'));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => removeTemporaryDirectory(root)));
});

async function fixture(release: Record<string, unknown>, codesignExit: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-candidate-identity-'));
  roots.push(root);
  const log = path.join(root, 'codesign-args.txt');
  const ditto = path.join(root, 'ditto');
  // Stands in for `ditto -x -k <archive> <destination>`: lays out one app bundle.
  await writeFile(
    ditto,
    `#!/bin/sh\nmkdir -p "$4/Soty.app/Contents/Resources"\ncat > "$4/Soty.app/Contents/Resources/release.json" <<'JSON'\n${JSON.stringify(release)}\nJSON\n`
  );
  const codesign = path.join(root, 'codesign');
  await writeFile(codesign, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nexit ${codesignExit}\n`);
  await chmod(ditto, 0o755);
  await chmod(codesign, 0o755);
  const work = path.join(root, 'work');
  await mkdir(work);
  return { root, work, log, tools: { ditto, codesign } };
}

describe('native update candidate publisher identity', () => {
  itPosix('requires a Developer ID Application certificate of the descriptor team', () => {
    const requirement = developerIdRequirement('TESTTEAM12');
    expect(requirement.startsWith('=anchor apple generic')).toBe(true);
    expect(requirement).toContain('1.2.840.113635.100.6.2.6');
    expect(requirement).toContain('1.2.840.113635.100.6.1.13');
    expect(requirement).toContain('certificate leaf[subject.OU] = "TESTTEAM12"');
    expect(() => developerIdRequirement('bad"team')).toThrow('APP_UPDATE_IDENTITY_MISMATCH');
  });

  itPosix('accepts the exact promised build signed by the promised team', async () => {
    const candidate = nativeCandidate();
    const f = await fixture(
      {
        buildId: candidate.buildId,
        sourceRevision: candidate.sourceRevision,
        target: candidate.target
      },
      0
    );
    await verifyNativeCandidateBundle(
      'archive.zip',
      candidate,
      f.work,
      new AbortController().signal,
      f.tools
    );
    const args = (await readFile(f.log, 'utf8')).trim().split('\n');
    expect(args.slice(0, 4)).toEqual(['--verify', '--deep', '--strict', '-R']);
    expect(args[4]).toBe(developerIdRequirement('TESTTEAM12'));
    // The extracted copy never outlives the check.
    expect(await readdir(f.work)).toEqual([]);
  });

  itPosix('refuses a bundle whose signature does not meet the team requirement', async () => {
    const candidate = nativeCandidate();
    const f = await fixture(
      {
        buildId: candidate.buildId,
        sourceRevision: candidate.sourceRevision,
        target: candidate.target
      },
      3
    );
    await expect(
      verifyNativeCandidateBundle(
        'archive.zip',
        candidate,
        f.work,
        new AbortController().signal,
        f.tools
      )
    ).rejects.toThrow('APP_UPDATE_IDENTITY_MISMATCH');
    expect(await readdir(f.work)).toEqual([]);
  });

  itPosix('refuses a correctly signed bundle of another build or target', async () => {
    const candidate = nativeCandidate();
    for (const release of [
      { buildId: '8.0.0+998', sourceRevision: candidate.sourceRevision, target: candidate.target },
      { buildId: candidate.buildId, sourceRevision: 'b'.repeat(40), target: candidate.target },
      { buildId: candidate.buildId, sourceRevision: candidate.sourceRevision, target: 'macos-x64' }
    ]) {
      const f = await fixture(release, 0);
      await expect(
        verifyNativeCandidateBundle(
          'archive.zip',
          candidate,
          f.work,
          new AbortController().signal,
          f.tools
        )
      ).rejects.toThrow('APP_UPDATE_IDENTITY_MISMATCH');
    }
  });
});
