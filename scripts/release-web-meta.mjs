#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateWebDeployment } from './lib/release/adapters/web.mjs';

async function filesUnder(root, relative = '') {
  const current = path.join(root, relative);
  const entries = await readdir(current, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async entry => {
        const next = path.join(relative, entry.name);
        return entry.isDirectory() ? filesUnder(root, next) : [next];
      })
  );
  return nested.flat();
}

export async function outputDigest(directory) {
  const hash = createHash('sha256');
  for (const relative of await filesUnder(directory)) {
    hash.update(relative);
    hash.update('\0');
    hash.update(await readFile(path.join(directory, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function writeWebMarker({ directory, output, binding, sourceSha, manifestSha }) {
  const marker = validateWebDeployment({
    binding,
    sourceSha,
    manifestSha,
    outputDigest: await outputDigest(directory)
  });
  await writeFile(output, JSON.stringify(marker), { mode: 0o600 });
  return marker;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [directory, output, bindingId, sourceSha, manifestSha] = process.argv.slice(2);
  if (!directory || !output || !bindingId || !sourceSha || !manifestSha)
    throw new Error(
      'Usage: release-web-meta <bundle-dir> <marker.json> <binding-id> <source-sha> <manifest-sha>'
    );
  process.stdout.write(
    `${JSON.stringify(await writeWebMarker({ directory: path.resolve(directory), output: path.resolve(output), binding: { bindingId }, sourceSha, manifestSha }))}\n`
  );
}
