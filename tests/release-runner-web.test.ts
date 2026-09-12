import { expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { webDeployMarker } from '../scripts/lib/release/adapters/web-deploy.mjs';
import { outputDigest, writeWebMarker } from '../scripts/release-web-meta.mjs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('binds deploy output to source, manifest and target identity', () => {
  expect(
    webDeployMarker({
      binding: { bindingId: 'sandbox' },
      sourceSha: 'a'.repeat(40),
      manifestSha: 'b'.repeat(40),
      outputDigest: 'c'.repeat(64)
    })
  ).toMatchObject({ bindingId: 'sandbox' });
});

it('writes a stable marker from bundle bytes, frozen source and manifest identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-web-'));
  try {
    const bundle = join(root, 'dist');
    await mkdir(bundle);
    await writeFile(join(bundle, 'index.html'), '<h1>Soty</h1>');
    const marker = await writeWebMarker({
      directory: bundle,
      output: join(root, 'marker.json'),
      binding: { bindingId: 'sandbox' },
      sourceSha: 'a'.repeat(40),
      manifestSha: 'b'.repeat(40)
    });
    expect(marker.outputDigest).toBe(await outputDigest(bundle));
    expect(JSON.parse(await readFile(join(root, 'marker.json'), 'utf8'))).toEqual(marker);
  } finally {
    await removeTemporaryDirectory(root);
  }
});
