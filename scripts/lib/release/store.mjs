import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function runnerRoot() {
  return process.env.SOTY_RELEASE_RUNNER_DIR ?? path.resolve('release/automation');
}

export function runDirectory(runId) { return path.join(runnerRoot(), runId); }
export function snapshotPath(runId) { return path.join(runDirectory(runId), 'snapshot.json'); }

export async function saveSnapshot(run) {
  const directory = runDirectory(run.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = snapshotPath(run.runId);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(run), { mode: 0o600 });
  await rename(temporary, target);
}

export async function loadSnapshot(runId) { return JSON.parse(await readFile(snapshotPath(runId), 'utf8')); }
