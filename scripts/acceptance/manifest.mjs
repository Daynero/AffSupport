import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, readdir, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { validateManifest } from './schema.mjs';

const MAX_BYTES = 65536;
const FROZEN_NAME = 'manifest.frozen.json';

function hasCode(error, code) {
  return error && typeof error === 'object' && 'code' in error && error.code === code;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])])
    );
  return value;
}
function encoded(manifest) {
  return JSON.stringify(canonical(manifest));
}
function digest(manifest) {
  return createHash('sha256')
    .update(encoded(manifest) + '\n')
    .digest('hex');
}

async function readManifest(file, optional = false, canonicalOnly = false) {
  let handle;
  try {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error('ACCEPTANCE_MANIFEST_PATH_UNSAFE');
    if (before.size > MAX_BYTES) throw new Error('ACCEPTANCE_MANIFEST_INVALID');
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || before.ino !== opened.ino || before.dev !== opened.dev)
      throw new Error('ACCEPTANCE_MANIFEST_PATH_UNSAFE');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_BYTES) throw new Error('ACCEPTANCE_MANIFEST_INVALID');
    const text = buffer.subarray(0, offset).toString('utf8');
    const value = JSON.parse(text);
    if (!validateManifest(value).ok) throw new Error('ACCEPTANCE_MANIFEST_INVALID');
    if (canonicalOnly && text !== encoded(value) + '\n')
      throw new Error('ACCEPTANCE_MANIFEST_MISMATCH');
    return value;
  } catch (error) {
    if (hasCode(error, 'ENOENT') && optional) return null;
    if (hasCode(error, 'ELOOP'))
      throw new Error('ACCEPTANCE_MANIFEST_PATH_UNSAFE', { cause: error });
    if (
      error instanceof Error &&
      ['ACCEPTANCE_MANIFEST_PATH_UNSAFE', 'ACCEPTANCE_MANIFEST_MISMATCH'].includes(error.message)
    )
      throw error;
    // Parser messages may quote rejected input; never attach that text to a public error.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('ACCEPTANCE_MANIFEST_INVALID');
  } finally {
    await handle?.close();
  }
}

async function hasRuns(root) {
  const directory = path.join(root, 'runs');
  try {
    if ((await realpath(directory)) !== directory) throw new Error('ACCEPTANCE_RECORD_PATH_UNSAFE');
    return (await readdir(directory)).length > 0;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function publishSnapshot(root, manifest) {
  const temporary = path.join(root, `.manifest-pending-${randomUUID()}`);
  let handle;
  let owned = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    owned = true;
    await handle.writeFile(encoded(manifest) + '\n');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      // A racing writer can publish the same complete snapshot, never replace it.
      await link(temporary, path.join(root, FROZEN_NAME));
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  } catch (error) {
    throw new Error('ACCEPTANCE_MANIFEST_PUBLISH_FAILED', { cause: error });
  } finally {
    await handle?.close();
    if (owned)
      await unlink(temporary).catch(error => {
        if (!hasCode(error, 'ENOENT'))
          throw new Error('ACCEPTANCE_MANIFEST_PUBLISH_FAILED', { cause: error });
      });
  }
}

/** Bind caller scope to disk; never retroactively attest to an existing legacy campaign. */
export async function bindCampaignManifest(root, input, { freeze = false } = {}) {
  if (!validateManifest(input).ok) throw new Error('ACCEPTANCE_MANIFEST_INVALID');
  const expected = digest(input);
  const canonicalRoot = await realpath(root);
  const stored = await readManifest(path.join(canonicalRoot, 'manifest.json'));
  if (digest(stored) !== expected) throw new Error('ACCEPTANCE_MANIFEST_MISMATCH');
  const frozenPath = path.join(canonicalRoot, FROZEN_NAME);
  let frozen = await readManifest(frozenPath, true, true);
  if (!frozen && freeze) {
    if (await hasRuns(canonicalRoot)) {
      // The first writer may have frozen and published while we read the directory.
      frozen = await readManifest(frozenPath, true, true);
      if (!frozen) throw new Error('ACCEPTANCE_MANIFEST_UNFROZEN');
    } else {
      await publishSnapshot(canonicalRoot, stored);
      frozen = await readManifest(frozenPath, false, true);
    }
  }
  if (frozen && digest(frozen) !== expected) throw new Error('ACCEPTANCE_MANIFEST_MISMATCH');
  // Refuse a changed live manifest even if it changed during the initial publication.
  if (digest(await readManifest(path.join(canonicalRoot, 'manifest.json'))) !== expected)
    throw new Error('ACCEPTANCE_MANIFEST_MISMATCH');
  if (!frozen && stored.mode === 'final') throw new Error('ACCEPTANCE_MANIFEST_UNFROZEN');
  return {
    root: canonicalRoot,
    manifest: stored,
    sha256: expected,
    state: frozen ? 'frozen' : 'legacy_unfrozen'
  };
}
