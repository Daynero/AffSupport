import { removeTemporaryDirectory } from './support/temp-dir.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { it, expect } from 'vitest';
import { assertPlatformBaseline } from '../scripts/lib/release/platform-baseline.mjs';
it('binds mini releases to both distinct Mac seals, source and the exact signed channel', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'platform-baseline-'));
  try {
    const sourceSha = 'a'.repeat(40);
    const digest = 'b'.repeat(64);
    const channel = Buffer.from(
      JSON.stringify({ artifacts: { 'windows-x64': { sha256: digest } } })
    );
    const proofs = ['macos-arm64', 'macos-x64'].map(target => ({
      target,
      sourceSha,
      payloadDigest: digest,
      webPayloadDigest: digest,
      proofDigest: digest
    }));
    const baseline = {
      schemaVersion: 1,
      sourceSha,
      signedChannelDigest: createHash('sha256').update(channel).digest('hex'),
      macos: Object.fromEntries(proofs.map(({ target, ...proof }) => [target, proof])),
      windows: {
        schemaVersion: 1,
        sourceSha,
        installerSha256: digest,
        smokeInstallerSha256: digest,
        workflowRunId: '123',
        validation: 'passed',
        installUseUninstall: 'passed',
        productionPackage: 'passed',
        verifiedAt: '2026-11-07T00:00:00Z'
      }
    };
    // The stored baseline includes the validated Windows schema discriminator.
    await mkdir(path.join(cwd, 'release/beta'), { recursive: true });
    await writeFile(
      path.join(cwd, 'release/beta/platform-baseline.json'),
      JSON.stringify(baseline)
    );
    await expect(assertPlatformBaseline(cwd, channel, proofs)).resolves.toMatch(/^[a-f0-9]{64}$/u);
    const staticProofs = [
      proofs[0],
      {
        ...proofs[1],
        verificationMode: 'static-cross-build',
        acceptancePolicy: 'intel-user-feedback-v1'
      }
    ];
    await expect(assertPlatformBaseline(cwd, channel, staticProofs)).rejects.toThrow(
      'TARGET_MISMATCH'
    );
    await writeFile(
      path.join(cwd, 'release/beta/platform-baseline.json'),
      JSON.stringify({
        ...baseline,
        macos: {
          ...baseline.macos,
          'macos-x64': {
            ...baseline.macos['macos-x64'],
            verificationMode: 'static-cross-build',
            acceptancePolicy: 'intel-user-feedback-v1'
          }
        }
      })
    );
    await expect(assertPlatformBaseline(cwd, channel, staticProofs)).resolves.toMatch(
      /^[a-f0-9]{64}$/u
    );
    await expect(assertPlatformBaseline(cwd, channel, proofs)).rejects.toThrow('TARGET_MISMATCH');
    await writeFile(
      path.join(cwd, 'release/beta/platform-baseline.json'),
      JSON.stringify(baseline)
    );
    await expect(assertPlatformBaseline(cwd, channel, [proofs[0], proofs[0]])).rejects.toThrow(
      'INCOMPLETE'
    );
    await expect(assertPlatformBaseline(cwd, Buffer.from('other'), proofs)).rejects.toThrow();
    await expect(
      assertPlatformBaseline(cwd, channel, [
        proofs[0],
        { ...proofs[1], webPayloadDigest: 'c'.repeat(64) }
      ])
    ).rejects.toThrow('TARGET_MISMATCH');
  } finally {
    await removeTemporaryDirectory(cwd);
  }
});
