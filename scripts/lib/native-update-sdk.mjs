import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, mkdtemp, rm, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isMachOFile } from './macos-payload.mjs';
export const SPARKLE = Object.freeze({
  version: '2.10.1',
  url: 'https://github.com/sparkle-project/Sparkle/releases/download/2.10.1/Sparkle-2.10.1.tar.xz',
  sha256: '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27',
  length: 16346336
});
const exec = promisify(execFile);
/** Fresh extraction from the checksum-pinned upstream archive, never a mutable framework cache. */
export async function withSparkle(work, root = path.resolve('release/.cache/sparkle')) {
  await mkdir(root, { recursive: true });
  const archive = path.join(root, `Sparkle-${SPARKLE.version}.tar.xz`);
  let bytes = await readFile(archive).catch(() => null);
  if (!bytes) {
    const response = await fetch(SPARKLE.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error('SPARKLE_DOWNLOAD_FAILED');
    const chunks = [];
    let length = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        length += chunk.length;
        if (length > SPARKLE.length) {
          await reader.cancel();
          throw new Error('SPARKLE_LENGTH_INVALID');
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    bytes = Buffer.concat(chunks);
  }
  if (
    bytes.length !== SPARKLE.length ||
    createHash('sha256').update(bytes).digest('hex') !== SPARKLE.sha256
  )
    throw new Error('SPARKLE_CHECKSUM_INVALID');
  await writeFile(archive, bytes, { mode: 0o600 });
  const temporary = await mkdtemp(path.join(root, 'sdk-'));
  try {
    const { stdout } = await exec('/usr/bin/tar', ['-tJf', archive]);
    if (stdout.split('\n').some(name => name.startsWith('/') || name.split('/').includes('..')))
      throw new Error('SPARKLE_ARCHIVE_UNSAFE');
    await exec('/usr/bin/tar', ['-xJf', archive, '-C', temporary]);
    return await work(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function stageSparkle(app) {
  return withSparkle(async sdk => {
    const frameworks = path.join(app, 'Contents/Frameworks');
    await mkdir(frameworks, { recursive: true });
    const destination = path.join(frameworks, 'Sparkle.framework');
    await rm(destination, { recursive: true, force: true });
    await cp(path.join(sdk, 'Sparkle.framework'), destination, {
      recursive: true,
      verbatimSymlinks: true
    });
    const licenses = path.join(app, 'Contents/Resources/licenses');
    await mkdir(licenses, { recursive: true });
    // The release's license is part of the pinned framework's Resources.
    await writeFile(path.join(licenses, 'Sparkle.txt'), await readFile(path.join(sdk, 'LICENSE')));
    const files = [];
    for (const entry of await readdir(destination, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (await isMachOFile(file))
        files.push({
          path: path.relative(app, file),
          sha256: createHash('sha256')
            .update(await readFile(file))
            .digest('hex')
        });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    await writeFile(
      path.join(app, 'Contents/Resources/native-update-sdk.json'),
      JSON.stringify({ ...SPARKLE, files }, null, 2) + '\n'
    );
  });
}
