import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, link, unlink } from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 64 * 1024;
function missing(error) {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
const NAMESPACE = /^acceptance-[a-z0-9][a-z0-9-]{2,63}$/;

async function location(namespace, name, root) {
  if (
    !NAMESPACE.test(namespace) ||
    (!['fixtures.json', 'reader.json', 'variants.json', 'cleanup.json'].includes(name) &&
      !/^mail-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u.test(name))
  )
    throw new Error('ACCEPTANCE_PRIVATE_STATE_INVALID');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('ACCEPTANCE_PRIVATE_STATE_UNSAFE');
  const base = await realpath(root);
  const directory = path.join(base, namespace);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink() || (await realpath(directory)) !== directory)
    throw new Error('ACCEPTANCE_PRIVATE_STATE_UNSAFE');
  const file = path.join(directory, name);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > LIMIT)
      throw new Error('ACCEPTANCE_PRIVATE_STATE_UNSAFE');
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return { directory, file };
}

/** Credentials stay in a bounded private file; rejected values never enter errors. */
export async function readPrivateState(namespace, name, root = 'release/acceptance-private') {
  const { file } = await location(namespace, name, root);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (missing(error)) throw error;
    // JSON parser messages can contain credentials; never retain the rejected text.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('ACCEPTANCE_PRIVATE_STATE_INVALID');
  }
}

/** Same-directory atomic publication preserves the last complete crash checkpoint. */
export async function writePrivateState(namespace, name, value, options = {}) {
  const { root = 'release/acceptance-private', createOnly = false } = options;
  if (name.startsWith('mail-') && !createOnly) throw new Error('ACCEPTANCE_PRIVATE_STATE_INVALID');
  const data = JSON.stringify(value);
  if (typeof data !== 'string' || Buffer.byteLength(data) > LIMIT)
    throw new Error('ACCEPTANCE_PRIVATE_STATE_INVALID');
  const { directory, file } = await location(namespace, name, root);
  const pending = path.join(directory, `.pending-${randomUUID()}`);
  const handle = await open(pending, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (createOnly) await link(pending, file);
    else await rename(pending, file);
  } finally {
    await unlink(pending).catch(error => {
      if (!missing(error)) throw error;
    });
  }
}
