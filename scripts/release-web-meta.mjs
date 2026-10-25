#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateWebDeployment } from './lib/release/adapters/web.mjs';

function unsafeArtifact() {
  return new Error('WEB_ARTIFACT_UNSAFE: bundle entries must be unchanged regular, unlinked files');
}

function sameEntry(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function bundleRoot(directory) {
  const root = path.resolve(directory);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafeArtifact();
  return { root: await realpath(root), stat };
}

/** @param {string} root @param {string} relative @param {{directory: string, stat: import('node:fs').Stats}[]} directories */
async function filesUnder(root, relative = '', directories = []) {
  const current = path.join(root, relative);
  const before = await lstat(current);
  if (!before.isDirectory() || before.isSymbolicLink()) throw unsafeArtifact();
  if ((await realpath(current)) !== current) throw unsafeArtifact();
  directories.push({ directory: current, stat: before });
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const next = path.join(relative, entry.name);
    const stat = await lstat(path.join(root, next));
    if (stat.isSymbolicLink()) throw unsafeArtifact();
    if (stat.isDirectory()) files.push(...(await filesUnder(root, next, directories)));
    else if (stat.isFile() && stat.nlink === 1) files.push(next);
    else throw unsafeArtifact();
  }
  if (!sameEntry(before, await lstat(current))) throw unsafeArtifact();
  return files;
}

/** Opens only a regular, unlinked entry below the real bundle root. */
async function openBundleFile(root, relative) {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/u).some(part => part === '..' || part === '.' || !part)
  )
    throw unsafeArtifact();
  const file = path.join(root, relative);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw unsafeArtifact();
  if ((await realpath(file)) !== file) throw unsafeArtifact();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameEntry(before, opened))
      throw unsafeArtifact();
    return { file, handle, before };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Bounded read used for security-sensitive files inside a bundle. */
export async function readWebFile(directory, relative, maxBytes = 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw unsafeArtifact();
  const { root } = await bundleRoot(directory);
  const { file, handle, before } = await openBundleFile(root, relative);
  try {
    if (before.size > maxBytes) throw unsafeArtifact();
    const chunks = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw unsafeArtifact();
      chunks.push(chunk);
    }
    if (
      bytes !== before.size ||
      !sameEntry(before, await handle.stat()) ||
      !sameEntry(before, await lstat(file)) ||
      (await realpath(file)) !== file
    )
      throw unsafeArtifact();
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

export async function outputDigest(directory) {
  const { root, stat } = await bundleRoot(directory);
  /** @type {{directory: string, stat: import('node:fs').Stats}[]} */
  const directories = [];
  const files = await filesUnder(root, '', directories);
  const hash = createHash('sha256');
  for (const relative of files) {
    const { file, handle, before } = await openBundleFile(root, relative);
    try {
      // Preserve the original canonical path/NUL/content/NUL digest format.
      hash.update(relative);
      hash.update('\0');
      let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        hash.update(chunk);
      }
      if (
        bytes !== before.size ||
        !sameEntry(before, await handle.stat()) ||
        !sameEntry(before, await lstat(file)) ||
        (await realpath(file)) !== file
      )
        throw unsafeArtifact();
      hash.update('\0');
    } finally {
      await handle.close();
    }
  }
  for (const entry of directories)
    if (!sameEntry(entry.stat, await lstat(entry.directory))) throw unsafeArtifact();
  if (!sameEntry(stat, await lstat(root))) throw unsafeArtifact();
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, output, bindingId, sourceSha, manifestSha] = process.argv.slice(2);
  if (!directory || !output || !bindingId || !sourceSha || !manifestSha)
    throw new Error(
      'Usage: release-web-meta <bundle-dir> <marker.json> <binding-id> <source-sha> <manifest-sha>'
    );
  process.stdout.write(
    `${JSON.stringify(await writeWebMarker({ directory: path.resolve(directory), output: path.resolve(output), binding: { bindingId }, sourceSha, manifestSha }))}\n`
  );
}
