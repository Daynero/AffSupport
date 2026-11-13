import { removeTemporaryDirectory } from './support/temp-dir';
import { mkdtemp, readFile, lstat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeUpdateReceipt, syncUpdateStateFiles } from '../apps/agent/src/update/receipt';
describe('durable workload receipt', () => {
  it('writes one owner-only atomic receipt independently of native state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-update-receipt-'));
    try {
      const body = {
        schemaVersion: 1 as const,
        attemptId: 'a',
        candidateId: 'c',
        installationId: 'i',
        bootId: 'b',
        epoch: 'e',
        stage: 'drained' as const
      };
      await writeUpdateReceipt(root, body);
      const file = path.join(root, 'workload.json');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(body);
      expect((await lstat(file)).mode & 0o077).toBe(0);
      await syncUpdateStateFiles([file]);
      await expect(readFile(path.join(root, 'native.json'))).rejects.toThrow();
    } finally {
      await removeTemporaryDirectory(root);
    }
  });
  it('refuses symlink storage and fails a missing final state file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-update-link-'));
    try {
      await symlink(root, path.join(root, 'linked'));
      await expect(
        writeUpdateReceipt(path.join(root, 'linked'), {
          schemaVersion: 1,
          attemptId: 'a',
          candidateId: 'c',
          installationId: 'i',
          bootId: 'b',
          epoch: 'e',
          stage: 'committed'
        })
      ).rejects.toThrow('APP_UPDATE_UNSAFE_INSTALLATION');
      await expect(syncUpdateStateFiles([path.join(root, 'missing')])).rejects.toThrow();
    } finally {
      await removeTemporaryDirectory(root);
    }
  });
});
