import { removeTemporaryDirectory } from './support/temp-dir.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RecoveryJournal,
  parseRecoveryCheckpoint
} from '../apps/agent/src/team-bridge/recovery-journal';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTemporaryDirectory(dir);
});
describe('durable recovery metadata', () => {
  it('atomically preserves the accepted operation over restart and contains no secret fields', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-recovery-'));
    dirs.push(root);
    const journal = new RecoveryJournal(root);
    const checkpoint = {
      delegationId: '34000000-0000-4000-8000-000000000001',
      requestId: '34000000-0000-4000-8000-000000000002',
      operationId: null,
      stage: 'claiming' as const,
      reason: null,
      updatedAt: new Date().toISOString()
    };
    await journal.save({ registrations: [], checkpoints: [checkpoint] });
    expect((await new RecoveryJournal(root).load()).checkpoints).toEqual([checkpoint]);
    const raw = await readFile(path.join(root, 'recovery.json'), 'utf8');
    expect(raw).not.toMatch(/refresh|ticket|leaseToken|sourceGrant|password/u);
  });
  it('refuses corrupt or oversized checkpoints rather than claiming work from guessed state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-recovery-'));
    dirs.push(root);
    const journal = new RecoveryJournal(root);
    await writeFile(path.join(root, 'recovery.json'), '{truncated');
    await expect(journal.load()).rejects.toThrow('INVALID_RESPONSE');
    await writeFile(path.join(root, 'recovery.json'), 'x'.repeat(256 * 1024 + 1));
    await expect(journal.load()).rejects.toThrow('INVALID_RESPONSE');
  });
  it.each([0, 120000])(
    'preserves the distinct server retry deadline %s across reload',
    async value => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'soty-recovery-'));
      dirs.push(root);
      const checkpoint = {
        delegationId: '34000000-0000-4000-8000-000000000001',
        requestId: '34000000-0000-4000-8000-000000000002',
        operationId: null,
        stage: 'blocked' as const,
        reason: 'retry_exhausted',
        updatedAt: new Date().toISOString(),
        retryNotBefore: Date.now() + 120000,
        serverRetryNotBefore: value === 0 ? 0 : Date.now() + value
      };
      await new RecoveryJournal(root).save({ registrations: [], checkpoints: [checkpoint] });
      expect((await new RecoveryJournal(root).load()).checkpoints).toEqual([checkpoint]);
    }
  );
  it.each([-1, Infinity, NaN, '120000', null])(
    'rejects an invalid server retry deadline %s',
    value => {
      expect(
        parseRecoveryCheckpoint({
          delegationId: '34000000-0000-4000-8000-000000000001',
          requestId: '34000000-0000-4000-8000-000000000002',
          operationId: null,
          stage: 'blocked',
          reason: 'retry_exhausted',
          updatedAt: new Date().toISOString(),
          serverRetryNotBefore: value
        })
      ).toBeNull();
    }
  );
});
