import { execFile } from 'node:child_process';
import { open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  acquireWebReleaseLock,
  assertNoPendingWebPublication,
  assertWebReleaseUnlocked,
  webReleaseStateFile
} from './web-only-lock.mjs';
import { atomicRecord } from './release/task-store.mjs';

const exec = promisify(execFile);

export class MiniDbWriterError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MiniDbWriterError';
    this.code = code;
  }
}

async function releaseOwnedLock(lock) {
  try {
    await lock?.release();
  } catch {
    throw new MiniDbWriterError('BACKEND_WRITER_RELEASE_FAILED');
  }
}

async function ownedAncestor(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid || pid === process.ppid) return true;
  if (process.platform === 'win32') return false;
  let current = process.ppid;
  for (let depth = 0; depth < 16 && current > 1; depth += 1) {
    const { stdout } = await exec('ps', ['-o', 'ppid=', '-p', String(current)], {
      timeout: 1_000,
      maxBuffer: 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
    });
    const parent = Number(stdout.trim());
    if (!Number.isInteger(parent) || parent <= 0 || parent === current) return false;
    if (parent === pid) return true;
    current = parent;
  }
  return false;
}

async function inheritedOwnership(root, token) {
  if (typeof token !== 'string' || !token)
    throw new MiniDbWriterError('BACKEND_WRITER_TOKEN_INVALID');
  const record = JSON.parse(
    await readFile(await webReleaseStateFile(root, 'web-release.lock'), 'utf8')
  );
  if (record.token !== token || !(await ownedAncestor(record.pid))) {
    throw new MiniDbWriterError('BACKEND_WRITER_TOKEN_INVALID');
  }
  await assertWebReleaseUnlocked(root, token);
  // An inherited lock is never permission to cross an existing uncertain write.
  await assertNoPendingWebPublication(root);
}

/** Shared local authority for every legacy backend apply, without changing its provider protocol.
 * @param {{root:string,owner:string,sourceSha:string,binding:any,journalPath:string,runId:string,inheritedToken?:string|null}} options
 * @param {(controls:{markWriting:()=>Promise<void>})=>Promise<any>} work
 */
export async function withLegacyBackendWriter(
  {
    root,
    owner,
    sourceSha,
    binding,
    journalPath,
    runId,
    inheritedToken = process.env.SOTY_WEB_RELEASE_LOCK_TOKEN ?? null
  },
  work
) {
  if (
    typeof root !== 'string' ||
    typeof owner !== 'string' ||
    !owner ||
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    !/^[a-f0-9]{64}$/.test(binding?.digest) ||
    typeof binding.bindingId !== 'string' ||
    !binding.bindingId ||
    typeof journalPath !== 'string' ||
    !path.isAbsolute(journalPath) ||
    typeof runId !== 'string' ||
    !runId ||
    typeof work !== 'function'
  ) {
    throw new MiniDbWriterError('BACKEND_WRITER_IDENTITY_INVALID');
  }
  let lock = null;
  const state = { marker: /** @type {{markerId:string}|null} */ (null) };
  try {
    if (inheritedToken) await inheritedOwnership(root, inheritedToken);
    else lock = await acquireWebReleaseLock({ root, owner });
    const pendingPath = await webReleaseStateFile(root, 'mini-db-pending.json');
    const markWriting = async () => {
      if (state.marker) return;
      const record = {
        schemaVersion: 1,
        kind: 'legacy-backend',
        markerId: randomUUID(),
        sourceSha,
        bindingDigest: binding.digest,
        bindingId: binding.bindingId,
        owner,
        journalPath,
        runId,
        pid: process.pid,
        time: new Date().toISOString()
      };
      await atomicRecord(pendingPath, record, true);
      state.marker = record;
    };
    const result = await work({ markWriting });
    if (result?.ok !== true) throw new MiniDbWriterError('BACKEND_WRITE_UNRESOLVED');
    if (state.marker) {
      if (
        !Array.isArray(result.applied) ||
        !result.applied.length ||
        result.applied.some(item => !['observed', 'already-applied'].includes(item?.state))
      ) {
        throw new MiniDbWriterError('BACKEND_WRITE_UNRESOLVED');
      }
      const current = JSON.parse(await readFile(pendingPath, 'utf8'));
      if (current.markerId !== state.marker.markerId || current.kind !== 'legacy-backend') {
        throw new MiniDbWriterError('BACKEND_PENDING_CHANGED');
      }
      await unlink(pendingPath);
      const directory = await open(path.dirname(pendingPath), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return result;
  } catch (error) {
    const candidate =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const message = error instanceof Error ? error.message : '';
    const code = /^[A-Z][A-Z0-9_]+$/.test(candidate)
      ? candidate
      : /^[A-Z][A-Z0-9_]+$/.test(message.split(':')[0])
        ? message.split(':')[0]
        : state.marker
          ? 'BACKEND_WRITE_UNRESOLVED'
          : 'BACKEND_WRITER_REFUSED';
    throw new MiniDbWriterError(code);
  } finally {
    await releaseOwnedLock(lock);
  }
}

/** Bind every adapter method to the original receiver; mark only actual apply calls. */
export function legacyBackendWriterAdapter(adapter, markWriting) {
  const wrapped = Object.create(adapter);
  for (const name of ['pendingMigrations', 'digestOf', 'backwardsCompatible', 'observe']) {
    Object.defineProperty(wrapped, name, {
      value: (...args) => adapter[name](...args),
      enumerable: true
    });
  }
  Object.defineProperty(wrapped, 'apply', {
    value: async (...args) => {
      await markWriting();
      return adapter.apply(...args);
    },
    enumerable: true
  });
  return wrapped;
}
