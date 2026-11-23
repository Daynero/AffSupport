import { constants } from 'node:fs';
import { open, mkdir, lstat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownerOnlyDirectory, syncDirectory, syncExistingFile } from '../platform/platform.js';

/** Flush the actual current queue files and parent entries after their writers settle. */
export async function syncUpdateStateFiles(files: string[]): Promise<void> {
  const parents = new Set<string>();
  for (const name of files) {
    await syncExistingFile(name);
    parents.add(path.dirname(name));
  }
  for (const directory of parents) {
    await syncDirectory(directory);
  }
}

/** Separate agent-owned receipt; never writes the native host's state file. */
export async function writeUpdateReceipt(
  directory: string,
  receipt: {
    schemaVersion: 1;
    attemptId: string;
    candidateId: string;
    installationId: string;
    bootId: string;
    epoch: string;
    stage: 'drained' | 'released' | 'committed';
  }
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!ownerOnlyDirectory(stat)) throw new Error('APP_UPDATE_UNSAFE_INSTALLATION');
  const temp = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    const file = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await file.writeFile(JSON.stringify(receipt) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path.join(directory, 'workload.json'));
    await syncDirectory(directory);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
