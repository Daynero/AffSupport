import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** @param {{workerPath: string, cwd: string, env: NodeJS.ProcessEnv, args?: string[]}} options */
export function startSupervisedWorker({ workerPath, cwd, env, args = [] }) {
  if (!path.isAbsolute(workerPath) || !path.isAbsolute(cwd)) throw new Error('SUPERVISOR_PATH_INVALID');
  const child = spawn(process.execPath, [workerPath, ...args], { cwd, env: { ...env }, detached: true, shell: false, stdio: 'ignore' });
  child.unref();
  return { pid: child.pid, workerPath, cwd };
}

export async function waitForWorkerReady(file, runId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = JSON.parse(await readFile(file, 'utf8'));
      if (ready?.runId === runId && ready.ready === true) return ready;
    } catch {
      // The worker writes atomically; absence while it starts is normal.
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('WORKER_READY_TIMEOUT');
}
