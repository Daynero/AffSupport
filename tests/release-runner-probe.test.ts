import { expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { inspectInstalledProbe } from '../scripts/lib/release/probes-macos.mjs';
import { provisionResourceProbe } from '../scripts/package-release-runner.mjs';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

it('blocks a missing installed probe without building one', async () => {
  await expect(
    inspectInstalledProbe({ executable: '/definitely/not/a/probe', digest: 'a'.repeat(64) })
  ).resolves.toMatchObject({ ok: false, code: 'PROBE_UNAVAILABLE' });
});

it('provisions only a supplied prebuilt probe with source provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-probe-'));
  try {
    const probe = join(root, 'probe');
    await writeFile(probe, '#!/bin/sh\necho "{}"\n');
    const manifest = await provisionResourceProbe({
      probePath: probe,
      destination: join(root, 'installed'),
      sourcePath: join(process.cwd(), 'packaging/release/ResourceProbe.swift')
    });
    expect(manifest.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

it('rejects a digest-matched executable that does not implement the probe protocol', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-probe-invalid-'));
  try {
    const executable = join(root, 'probe');
    await writeFile(executable, '#!/bin/sh\necho "{}"\n');
    await chmod(executable, 0o755);
    const digest = createHash('sha256')
      .update(await readFile(executable))
      .digest('hex');
    await expect(inspectInstalledProbe({ executable, digest })).resolves.toMatchObject({
      ok: false,
      reason: 'typed_output_invalid'
    });
  } finally {
    await removeTemporaryDirectory(root);
  }
});
