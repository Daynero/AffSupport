import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import {
  withLegacyBackendWriter,
  legacyBackendWriterAdapter
} from '../scripts/lib/mini-db-writer-lock.mjs';
import {
  acquireWebReleaseLock,
  assertWebReleaseUnlocked,
  webReleaseStateFile
} from '../scripts/lib/web-only-lock.mjs';
import { atomicRecord } from '../scripts/lib/release/task-store.mjs';
import { createJournal } from '../scripts/lib/release/journal.mjs';
import { createStepAdapter } from '../scripts/lib/release/step-adapter.mjs';

const roots: string[] = [];
const binding = { kind: 'sandbox', bindingId: 'fixture', digest: 'a'.repeat(64) };
const sourceSha = 'b'.repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mini-db-writer-'));
  roots.push(root);
  return {
    root,
    owner: 'fixture-backend',
    sourceSha,
    binding,
    journalPath: join(root, 'journal.jsonl'),
    runId: 'fixture',
    inheritedToken: null
  };
}

async function pending(root: string) {
  return JSON.parse(
    await readFile(await webReleaseStateFile(root, 'mini-db-pending.json'), 'utf8')
  );
}

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryDirectory(root);
});

describe('one canonical writer for legacy and mini backend changes', () => {
  it.each(['mini-db', 'legacy-backend'])(
    'blocks inherited web upload authority while a %s database write is unresolved',
    async kind => {
      const options = await fixture();
      const owner = await acquireWebReleaseLock({ root: options.root, owner: 'outer' });
      try {
        await atomicRecord(await webReleaseStateFile(options.root, 'mini-db-pending.json'), {
          schemaVersion: 1,
          kind
        });
        await expect(assertWebReleaseUnlocked(options.root, owner.token)).rejects.toThrow(
          'DB_PUBLICATION_UNRESOLVED'
        );
      } finally {
        await owner.release();
      }
    }
  );

  it('releases admission without a pending marker after before-write validation fails', async () => {
    const options = await fixture();
    await expect(
      withLegacyBackendWriter(options, async () => {
        throw new Error('private provider details');
      })
    ).rejects.toMatchObject({ code: 'BACKEND_WRITER_REFUSED' });
    await expect(pending(options.root)).rejects.toMatchObject({ code: 'ENOENT' });
    const next = await acquireWebReleaseLock({ root: options.root, owner: 'later' });
    await next.release();
  });

  it('fsyncs a pending marker before apply, preserves the adapter receiver, and holds authority through readback', async () => {
    const options = await fixture();
    class Provider {
      #id = 'original-provider';
      async apply() {
        expect(this.#id).toBe('original-provider');
        expect(await pending(options.root)).toMatchObject({
          kind: 'legacy-backend',
          sourceSha,
          bindingDigest: binding.digest
        });
        return { ok: true };
      }
    }
    await withLegacyBackendWriter(options, async ({ markWriting }) => {
      const provider = legacyBackendWriterAdapter(Object.freeze(new Provider()), markWriting);
      await provider.apply();
      await expect(
        acquireWebReleaseLock({ root: options.root, owner: 'competing' })
      ).rejects.toThrow('WEB_RELEASE_BUSY');
      expect((await pending(options.root)).journalPath).toBe(options.journalPath);
      return { ok: true, applied: [{ id: 'migration', state: 'observed' }] };
    });
    await expect(pending(options.root)).rejects.toMatchObject({ code: 'ENOENT' });
    const next = await acquireWebReleaseLock({ root: options.root, owner: 'later' });
    await next.release();
  });

  it('retains an uncertain marker and blocks the next writer after provider transport loss', async () => {
    const options = await fixture();
    await expect(
      withLegacyBackendWriter(options, async ({ markWriting }) => {
        await markWriting();
        throw new Error('secret connectionString');
      })
    ).rejects.toMatchObject({ code: 'BACKEND_WRITE_UNRESOLVED' });
    expect(await pending(options.root)).toMatchObject({ kind: 'legacy-backend', runId: 'fixture' });
    await expect(
      readFile(await webReleaseStateFile(options.root, 'web-release.lock'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(withLegacyBackendWriter(options, async () => ({ ok: true }))).rejects.toThrow(
      /UNRESOLVED/
    );
  });

  it('does not clear the fence for the legacy ok:true retryable outcome', async () => {
    const options = await fixture();
    await expect(
      withLegacyBackendWriter(options, async ({ markWriting }) => {
        await markWriting();
        return { ok: true, applied: [{ state: 'retryable' }] };
      })
    ).rejects.toMatchObject({ code: 'BACKEND_WRITE_UNRESOLVED' });
    expect((await pending(options.root)).kind).toBe('legacy-backend');
  });

  it('refuses a pending mini transaction before calling any legacy work', async () => {
    const options = await fixture();
    await atomicRecord(await webReleaseStateFile(options.root, 'mini-db-pending.json'), {
      kind: 'mini-db',
      schemaVersion: 1
    });
    let called = false;
    await expect(
      withLegacyBackendWriter(options, async () => {
        called = true;
        return { ok: true };
      })
    ).rejects.toThrow(/UNRESOLVED/);
    expect(called).toBe(false);
    expect((await pending(options.root)).kind).toBe('mini-db');
  });

  it('accepts its live owning process token while leaving release ownership with the parent', async () => {
    const options = await fixture();
    const outer = await acquireWebReleaseLock({ root: options.root, owner: 'outer' });
    await withLegacyBackendWriter({ ...options, inheritedToken: outer.token }, async () => ({
      ok: true
    }));
    await expect(acquireWebReleaseLock({ root: options.root, owner: 'competing' })).rejects.toThrow(
      'WEB_RELEASE_BUSY'
    );
    await outer.release();
  });

  it('rejects a copied token with an unrelated or malformed owner PID', async () => {
    const options = await fixture();
    const outer = await acquireWebReleaseLock({ root: options.root, owner: 'outer' });
    const lockPath = await webReleaseStateFile(options.root, 'web-release.lock');
    const original = await readFile(lockPath, 'utf8');
    await writeFile(lockPath, JSON.stringify({ ...JSON.parse(original), pid: 0 }));
    try {
      await expect(
        withLegacyBackendWriter({ ...options, inheritedToken: outer.token }, async () => ({
          ok: true
        }))
      ).rejects.toMatchObject({ code: 'BACKEND_WRITER_TOKEN_INVALID' });
    } finally {
      await writeFile(lockPath, original);
      await outer.release();
    }
  });

  it('integrates the full backend step without writing any state under the actual repository', async () => {
    const options = await fixture();
    const journal = await createJournal(join(options.root, 'journal'), options.runId);
    await journal.append('fixture_created', {});
    const change = {
      id: '20261025120000',
      kind: 'migration',
      targetId: binding.bindingId,
      digest: 'c'.repeat(64)
    };
    let applied = false;
    const backendAdapter = {
      pendingMigrations: async () => [change.id],
      digestOf: async () => change.digest,
      backwardsCompatible: async () => true,
      apply: async () => {
        applied = true;
        expect((await pending(options.root)).kind).toBe('legacy-backend');
        return { ok: true, transaction: 'transactional' };
      },
      observe: async () => ({
        historyPresent: applied,
        postconditionsPass: applied,
        targetId: binding.bindingId
      })
    };
    const adapter = await createStepAdapter({
      runId: options.runId,
      version: '1.2.3',
      sourceSha,
      cwd: options.root,
      binding,
      env: { SOTY_WEB_RELEASE_LOCK_TOKEN: '' },
      backendPlan: { changes: [change] },
      backendAdapter,
      journal,
      allowRemote: true
    });
    expect(await adapter.execute('backend_apply')).toEqual({ ok: true });
    expect(applied).toBe(true);
    await expect(pending(options.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
