import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function acquireOwnership(directory, identity) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, 'owner.json');
  const payload = JSON.stringify({ ...identity, acquiredAt: new Date().toISOString() });
  try {
    const lock = await open(lockPath, 'wx', 0o600);
    await lock.write(payload); await lock.sync();
    return { acquired: true, lockPath, owner: JSON.parse(payload), async release() { await lock.close(); await unlink(lockPath).catch(() => {}); } };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    return { acquired: false, lockPath, owner: JSON.parse(await readFile(lockPath, 'utf8')) };
  }
}

export async function registerChild(directory, child) {
  const registryPath = path.join(directory, 'children.json');
  let children = [];
  try { children = JSON.parse(await readFile(registryPath, 'utf8')); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  children.push(child);
  await writeFile(registryPath, JSON.stringify(children), { mode: 0o600 });
  return children;
}

/**
 * A PID is not sufficient proof of ownership: callers must also retain the
 * process start marker recorded at spawn time. The platform probe is injected
 * so tests do not depend on host-specific procfs APIs.
 * @param {{pid: number, startedAt: number, bootId: string}} recorded
 * @param {{isAlive: (pid: number) => boolean, startedAt: (pid: number) => number | null, bootId: () => string}} probe
 */
export function ownsLiveProcess(recorded, probe) {
  return (
    probe.isAlive(recorded.pid) &&
    probe.startedAt(recorded.pid) === recorded.startedAt &&
    probe.bootId() === recorded.bootId
  );
}
