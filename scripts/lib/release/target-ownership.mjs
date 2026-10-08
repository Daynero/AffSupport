import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { atomicRecord, validTaskId } from './task-store.mjs';

const exec = promisify(execFile);
export async function processIdentity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('INVALID_PID');
  try { process.kill(pid, 0); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return null;
    throw new Error('PROCESS_OWNERSHIP_AMBIGUOUS', { cause: error });
  }
  const marker = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5000 });
  const boot = await exec('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { timeout: 5000 });
  if (!marker.stdout.trim() || !boot.stdout.trim()) throw new Error('PROCESS_OWNERSHIP_AMBIGUOUS');
  return { pid, startMarker: marker.stdout.trim(), bootId: boot.stdout.trim() };
}

export async function claimTarget(root, targetId, taskId, identity, inspect = processIdentity) {
  validTaskId(taskId);
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || typeof identity.startMarker !== 'string' || typeof identity.bootId !== 'string') throw new Error('PROCESS_OWNERSHIP_AMBIGUOUS');
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(targetId)) throw new Error('INVALID_TARGET_ID');
  const file = path.join(root, 'targets', `${targetId}.json`);
  const owner = { taskId, targetId, ...identity, nonce: randomUUID() };
  const release = async () => {
    const current = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (current?.nonce === owner.nonce) await unlink(file);
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await atomicRecord(file, owner, true); return { acquired: true, owner, release }; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const previous = JSON.parse(await readFile(file, 'utf8'));
      const actual = await inspect(previous.pid);
      if (actual && actual.startMarker === previous.startMarker && actual.bootId === previous.bootId) return { acquired: false, owner: previous, release: async () => {} };
      const reclaim = `${file}.reclaim`;
      try { await atomicRecord(reclaim, owner, true); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return { acquired: false, owner: previous, release: async () => {} };
        throw error;
      }
      try {
        const current = JSON.parse(await readFile(file, 'utf8'));
        if (current.nonce === previous.nonce) await rename(file, `${file}.retired-${previous.nonce}`);
      } finally { await unlink(reclaim); }
    }
  }
  throw new Error('TARGET_OWNERSHIP_CONFLICT');
}
