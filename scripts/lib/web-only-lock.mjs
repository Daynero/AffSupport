import { mkdir, open, readFile, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function webReleaseStateFile(root, name) {
  if (
    ![
      'web-release.lock',
      'web-publication-pending.json',
      'mini-db-pending.json',
      'mini-db-state.json'
    ].includes(name)
  )
    throw new Error('WEB_RELEASE_STATE_NAME_INVALID');
  // Every detached worktree shares the main repository's writer namespace.
  const gitEntry = await lstat(path.join(root, '.git')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (gitEntry) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    );
    const { stdout } = await exec(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: root, env, timeout: 5000, maxBuffer: 8192 }
    );
    root = path.dirname(stdout.trim());
  }
  return path.join(root, 'release/automation', name);
}

export async function assertNoPendingWebPublication(root) {
  return assertNoPending(root, ['web-publication-pending.json', 'mini-db-pending.json']);
}

async function assertNoPending(root, names) {
  for (const name of names) {
    try {
      await readFile(await webReleaseStateFile(root, name), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw new Error('WEB_ONLY_PENDING_RECORD_UNREADABLE', { cause: error });
    }
    throw new Error(
      name === 'mini-db-pending.json'
        ? 'DB_PUBLICATION_UNRESOLVED: reconcile the recorded database transaction before another write'
        : 'WEB_ONLY_PUBLICATION_UNRESOLVED: reconcile before another web write'
    );
  }
}

/** @param {string} root @param {string|null} token */
export async function assertWebReleaseUnlocked(root, token = null) {
  let record;
  try {
    record = JSON.parse(
      await readFile(await webReleaseStateFile(root, 'web-release.lock'), 'utf8')
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return assertNoPendingWebPublication(root);
    throw new Error('WEB_RELEASE_LOCK_UNREADABLE', { cause: error });
  }
  if (token && record.token === token) {
    // An owned upload must cross its own web pending marker, but never an
    // unresolved database write from either backend path.
    await assertNoPending(root, ['mini-db-pending.json']);
    try {
      if (!Number.isInteger(record.pid) || record.pid <= 0) throw new Error('owner');
      process.kill(record.pid, 0);
      return;
    } catch {
      /* stale ownership is never adopted */
    }
  }
  throw new Error(
    'WEB_RELEASE_BUSY: inspect the existing owner before retrying; no automatic stale-lock removal'
  );
}

export async function acquireWebReleaseLock({ root, owner, allowPending = false }) {
  const filePath = await webReleaseStateFile(root, 'web-release.lock');
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  let file;
  try {
    file = await open(filePath, 'wx', 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error('WEB_RELEASE_BUSY: another release or recovery owns this checkout', {
        cause: error
      });
    throw error;
  }
  try {
    if (!allowPending) await assertNoPendingWebPublication(root);
    await file.writeFile(
      JSON.stringify({
        schemaVersion: 1,
        owner,
        token,
        pid: process.pid,
        startedAt: new Date().toISOString()
      })
    );
    await file.sync();
  } catch (error) {
    await rm(filePath, { force: true });
    throw error;
  } finally {
    await file.close();
  }
  const directory = await open(path.dirname(filePath), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  const release = async () => {
    const current = JSON.parse(
      await readFile(await webReleaseStateFile(root, 'web-release.lock'), 'utf8')
    );
    if (current.token !== token || current.pid !== process.pid)
      throw new Error('WEB_RELEASE_LOCK_CHANGED');
    await rm(filePath);
  };
  return { token, release };
}
