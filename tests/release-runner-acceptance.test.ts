import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { inspectAcceptanceDependencies } from '../scripts/release-acceptance.mjs';

it('fails closed when installed acceptance dependencies are absent or malformed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-acceptance-'));
  try {
    await expect(
      inspectAcceptanceDependencies({
        probePath: join(root, 'missing'),
        probeDigest: 'a'.repeat(64),
        leaseSocket: join(root, 'missing.sock'),
        bridgeConfigPath: join(root, 'missing.json')
      })
    ).resolves.toMatchObject({ ok: false, code: 'PROBE_UNAVAILABLE' });
    const probe = join(root, 'probe');
    const reading = {
      version: 1,
      observedAt: '2026-01-01T00:00:00.000Z',
      uptimeNs: 1_000_000,
      bootId: 'boot-a',
      physicalBytes: 17179869184,
      cpuTicks: { user: 1, system: 1, nice: 0, idle: 10 },
      availableBytes: 8e9,
      pressure: 'normal',
      swapUsedBytes: 0,
      diskFreeBytes: 20e9,
      thermal: 'nominal'
    };
    await writeFile(probe, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(reading)}\nJSON\n`);
    await chmod(probe, 0o755);
    const digest = createHash('sha256')
      .update(await readFile(probe))
      .digest('hex');
    await expect(
      inspectAcceptanceDependencies({
        probePath: probe,
        probeDigest: digest,
        leaseSocket: join(root, 'missing.sock'),
        bridgeConfigPath: join(root, 'missing.json')
      })
    ).resolves.toMatchObject({ ok: false, code: 'LEASE_SOCKET_UNAVAILABLE' });
  } finally {
    await removeTemporaryDirectory(root);
  }
});
