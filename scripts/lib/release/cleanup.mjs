import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** Removes only completed, aged run directories directly beneath the owned root. */
export async function cleanupRuns(root, { now = Date.now(), retentionMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const removed = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const snapshotPath = path.join(directory, 'snapshot.json');
    try {
      const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
      const age = now - (await stat(directory)).mtimeMs;
      if (snapshot.state === 'completed' && age >= retentionMs) {
        await rm(directory, { recursive: true, force: true });
        removed.push(entry.name);
      }
    } catch {
      // Unknown/incomplete directories are evidence, never cleanup candidates.
    }
  }
  return removed;
}
