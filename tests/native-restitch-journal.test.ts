import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  NativeRestitchExecutor,
  type NativeRestitchCheckpoint
} from '../apps/agent/src/team-bridge/native-restitch-executor';
import {
  NativeRestitchJournal,
  NATIVE_RESTITCH_JOURNAL_BYTES
} from '../apps/agent/src/team-bridge/native-restitch-journal';
import { removeTemporaryDirectory } from './support/temp-dir';
const id = (n: number) => `b1710000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'native-restitch-journal-'));
});
afterEach(async () => {
  await removeTemporaryDirectory(root);
});
const file = () => path.join(root, 'restitch-executors.json');
function row(n = 1): NativeRestitchCheckpoint {
  return {
    identity: {
      rootOperationId: id(n),
      teamId: id(2),
      actorId: id(3),
      claimId: id(4),
      nativeInstanceId: id(5),
      installedContract: 1
    },
    receipt: null,
    quiescenceId: null,
    phase: 'blocked',
    reason: 'claim_unconfirmed',
    outcome: null,
    touchedAt: '2026-11-07T12:00:00.000Z'
  };
}
it('distinguishes a missing journal from a successfully loaded empty snapshot', async () => {
  const journal = new NativeRestitchJournal(root);
  expect(journal.observation()).toBe('unread');
  expect(await journal.load()).toEqual([]);
  expect(journal.observation()).toBe('missing');
  await journal.save([]);
  expect(await journal.load()).toEqual([]);
  expect(journal.observation()).toBe('loaded');
});
it('captures validated metadata before caller mutation and excludes unrelated content', async () => {
  const journal = new NativeRestitchJournal(root),
    value = Object.assign(row(), {
      providerPayload: 'NEVER_COLLECT_THIS',
      path: '/private/user-content'
    });
  const saved = journal.save([value]);
  value.identity.actorId = id(99);
  value.phase = 'claiming';
  await saved;
  expect(await journal.load()).toEqual([row()]);
  const bytes = await readFile(file(), 'utf8');
  expect(bytes).not.toContain('NEVER_COLLECT_THIS');
  expect(bytes).not.toContain('/private/user-content');
});
it('serializes overlapping replacements and leaves no staged files', async () => {
  const journal = new NativeRestitchJournal(root);
  await Promise.all([journal.save([row(10)]), journal.save([row(11)])]);
  expect(await journal.load()).toEqual([row(11)]);
  expect(await readdir(root)).toEqual(['restitch-executors.json']);
});
it('keeps an existing unknown owner when a duplicate-root snapshot is refused', async () => {
  const journal = new NativeRestitchJournal(root);
  await journal.save([row()]);
  await expect(journal.save([row(), row()])).rejects.toMatchObject({
    message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(await journal.load()).toEqual([row()]);
});
it('refuses too many roots without replacing the previous evidence', async () => {
  const journal = new NativeRestitchJournal(root);
  await journal.save([row()]);
  await expect(
    journal.save(Array.from({ length: 65 }, (_, n) => row(100 + n)))
  ).rejects.toMatchObject({ message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect(await journal.load()).toEqual([row()]);
});
it('refuses an oversized on-disk journal instead of loading it as empty', async () => {
  const journal = new NativeRestitchJournal(root);
  await writeFile(file(), ' '.repeat(NATIVE_RESTITCH_JOURNAL_BYTES + 1));
  await expect(journal.load()).rejects.toMatchObject({
    message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
    reason: 'journal_invalid'
  });
  expect(journal.observation()).toBe('unconfirmed');
});
it('sanitizes parser failures without exposing content, a raw path or a parser cause', async () => {
  const journal = new NativeRestitchJournal(root);
  await writeFile(file(), '{"private":"NEVER_COLLECT_THIS"');
  const error = await journal.load().catch(cause => cause as Error);
  expect(error).toMatchObject({
    message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
    reason: 'journal_invalid'
  });
  expect(String(error)).not.toContain('NEVER_COLLECT_THIS');
  expect(String(error)).not.toContain(root);
  expect(error instanceof Error ? error.cause : undefined).toBeUndefined();
});
it('refuses a fabricated quiescent checkpoint without an owned receipt and exact closure nonce', async () => {
  const journal = new NativeRestitchJournal(root),
    value = { ...row(), phase: 'quiescent' };
  await writeFile(file(), JSON.stringify({ schemaVersion: 1, records: [value] }));
  await expect(journal.load()).rejects.toMatchObject({
    message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(journal.observation()).toBe('unconfirmed');
});
it('retains a real filesystem checkpoint across restart and prevents a fresh claim over uncertainty', async () => {
  const claim = vi.fn(async () => {
    throw Error('lost acknowledgement');
  });
  const make = (nativeInstanceId: string) =>
    new NativeRestitchExecutor({
      nativeInstanceId,
      maxRetained: 8,
      currentActorId: () => id(3),
      authority: { claim, quiesce: async () => true },
      journal: new NativeRestitchJournal(root)
    });
  const first = make(id(5));
  await first.initialize();
  await expect(first.execute(row().identity, async () => 1)).rejects.toMatchObject({
    message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  const restarted = make(id(55));
  await restarted.initialize();
  await expect(
    restarted.execute({ ...row().identity, claimId: id(99) }, async () => 1)
  ).rejects.toMatchObject({ message: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect(claim).toHaveBeenCalledTimes(1);
  expect(restarted.snapshot(id(1))?.identity.nativeInstanceId).toBe(id(5));
});
