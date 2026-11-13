import { withCatalogGlobalCapacity } from '../scripts/lib/catalog-global-capacity.mjs';
import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  globalTestDb,
  globalControl,
  globalCutover,
  GLOBAL_OTHER,
  GLOBAL_OWNER
} from './support/catalog-global-db.js';
import type { TeamTestDb } from './support/team-db.js';
let db: TeamTestDb;
beforeAll(async () => {
  ({ db } = await globalTestDb());
}, 60_000);
afterAll(async () => {
  await db?.close();
});
it('requires an explicit operator for import and cutover', async () => {
  await expect(
    globalControl(
      db,
      'begin',
      { idempotencyKey: 'fixture-import', totalFiles: 1, totalBytes: '1000' },
      GLOBAL_OTHER
    )
  ).rejects.toThrow('PERMISSION_DENIED');
  await expect(globalCutover(db, 'prepare', {}, GLOBAL_OTHER)).rejects.toThrow('PERMISSION_DENIED');
});
it('freezes a bounded manifest and idempotent grant, then fences late cancelled work', async () => {
  const payload = { idempotencyKey: 'fixture-import', totalFiles: 1, totalBytes: '1000' };
  const job = await globalControl(db, 'begin', payload);
  expect(await globalControl(db, 'begin', payload)).toEqual(job);
  await expect(globalControl(db, 'begin', { ...payload, totalBytes: '1001' })).rejects.toThrow(
    'IDEMPOTENCY_CONFLICT'
  );
  const page = {
    jobId: job.id,
    pageKey: 'page1',
    entries: [
      {
        fileKey: 'one',
        displayName: 'hoodie.jpg',
        size: 1000,
        mime: 'image/jpeg',
        classification: {
          mode: 'unclassified',
          garment: null,
          color: null,
          reason: 'unknown',
          vocabularyVersion: 'catalog-clothing-v1'
        }
      }
    ]
  };
  const manifest = await globalControl(db, 'manifest', page);
  expect(await globalControl(db, 'manifest', page)).toEqual(manifest);
  await globalControl(db, 'seal', { jobId: job.id });
  const entry = (manifest.entries as { id: string }[])[0]!;
  const request = { jobId: job.id, entryId: entry.id, requestKey: 'grant-key-0001' };
  const grant = await globalControl(db, 'grant', request);
  expect(await globalControl(db, 'grant', request)).toEqual(grant);
  expect(grant).toMatchObject({ generation: 1 });
  await globalControl(db, 'cancel', { jobId: job.id });
  await expect(
    globalControl(db, 'grant', { ...request, requestKey: 'grant-key-0002' })
  ).rejects.toThrow('WRONG_STATE');
  const [row] = await db.root<{ activated_at: null }>(
    'select activated_at from private.catalog_global_policy'
  );
  expect(row!.activated_at).toBeNull();
  const [acl] = await db.root<{ allowed: boolean }>(
    "select has_function_privilege('authenticated','public.service_catalog_global_control(uuid,text,jsonb)','execute') allowed"
  );
  expect(acl!.allowed).toBe(false);
  expect(GLOBAL_OWNER).not.toBe(GLOBAL_OTHER);
});
it('can reopen pre-T0 recovery explicitly without activating or deleting bytes', async () => {
  await globalCutover(db, 'prepare');
  await expect(globalCutover(db, 'resume_legacy', { confirmation: 'wrong' })).rejects.toThrow(
    'GLOBAL_IMAGE_POLICY_CONFLICT'
  );
  expect(await globalCutover(db, 'resume_legacy', { confirmation: 'resume-legacy:beta' })).toEqual({
    state: 'prepared',
    activation: false
  });
  const [policy] = await db.root<{ activated_at: null }>(
    'select activated_at from private.catalog_global_policy'
  );
  expect(policy!.activated_at).toBeNull();
});

it('reclaims only an abandoned unpublished byte reservation without reviving the cancelled worker fence', async () => {
  const create = async (
    key: string,
    classification: Record<string, unknown> = {
      mode: 'unclassified',
      garment: null,
      color: null,
      reason: 'unknown',
      vocabularyVersion: 'catalog-clothing-v1'
    }
  ) => {
    const job = await globalControl(db, 'begin', {
      idempotencyKey: key,
      totalFiles: 1,
      totalBytes: '1000'
    });
    const manifested = await globalControl(db, 'manifest', {
      jobId: job.id,
      pageKey: 'one',
      entries: [
        {
          fileKey: 'file',
          displayName: 'owned.jpg',
          size: 1000,
          mime: 'image/jpeg',
          classification
        }
      ]
    });
    await globalControl(db, 'seal', { jobId: job.id });
    const entry = (manifested.entries as { id: string }[])[0]!;
    await globalControl(db, 'grant', {
      jobId: job.id,
      entryId: entry.id,
      requestKey: 'grant-abandoned-01'
    });
    await globalControl(db, 'delivered', { jobId: job.id, entryId: entry.id });
    return job;
  };
  const work = async (action: string, data: Record<string, unknown> = {}) =>
    (
      await db.root<{ value: Record<string, unknown> }>(
        'select public.service_catalog_global_work($1,$2,$3) value',
        [action, 'fixture:abandoned', JSON.stringify(data)]
      )
    )[0]!.value;
  const firstJob = await create('abandoned-first');
  const first = await work('claim');
  const reserve = {
    entryId: first.id,
    fence: first.fence,
    sha256: 'b'.repeat(64),
    mime: 'image/jpeg',
    size: 1000,
    width: 500,
    height: 500
  };
  const original = await work('reserve', reserve);
  await globalControl(db, 'cancel', { jobId: firstJob.id });
  await create('abandoned-reimport');
  const second = await work('claim');
  const reclaimed = await work('reserve', { ...reserve, entryId: second.id, fence: second.fence });
  expect(reclaimed.id).toBe(original.id);
  const [image] = await db.root<{ owner_entry_id: string; state: string }>(
    'select owner_entry_id,state from private.catalog_global_images where id=$1',
    [original.id]
  );
  expect(image).toEqual({ owner_entry_id: second.id, state: 'verifying' });
  await expect(
    work('finish', { entryId: first.id, fence: first.fence, success: true })
  ).rejects.toThrow('LEASE_MISMATCH');
  await create('conflicting-reimport', {
    mode: 'matched',
    garment: 'Hoodie',
    color: 'black',
    vocabularyVersion: 'catalog-clothing-v1'
  });
  const conflicting = await work('claim');
  await expect(
    work('reserve', { ...reserve, entryId: conflicting.id, fence: conflicting.fence })
  ).rejects.toThrow('IMAGE_CLASSIFICATION_CONFLICT');
});

it('waits for definite staging capacity while retaining the same operation closure and bounded RPC budgets', async () => {
  let time = 0,
    calls = 0;
  const waits: number[] = [],
    budgets: number[] = [];
  const result = await withCatalogGlobalCapacity(
    async budget => {
      budgets.push(budget);
      if (++calls < 3) throw new Error('IMAGE_UPLOAD_CAPACITY_BUSY');
      return 'same-durable-grant';
    },
    {
      now: () => time,
      sleep: async ms => {
        waits.push(ms);
        time += ms;
      }
    }
  );
  expect(result).toBe('same-durable-grant');
  expect(calls).toBe(3);
  expect(waits).toEqual([250, 500]);
  expect(budgets.every(value => value > 0 && value <= 15000)).toBe(true);
});
it('does not replay unknown grants or cancellation, and bounds a persistently full queue', async () => {
  for (const code of ['IMAGE_WRITE_UNCERTAIN', 'WRONG_STATE']) {
    let calls = 0;
    await expect(
      withCatalogGlobalCapacity(
        async () => {
          calls++;
          throw new Error(code);
        },
        {
          sleep: async () => {
            throw new Error('unexpected wait');
          }
        }
      )
    ).rejects.toThrow(code);
    expect(calls).toBe(1);
  }
  let time = 0,
    calls = 0;
  await expect(
    withCatalogGlobalCapacity(
      async () => {
        calls++;
        throw new Error('IMAGE_UPLOAD_CAPACITY_BUSY');
      },
      {
        now: () => time,
        sleep: async ms => {
          time += ms;
        }
      }
    )
  ).rejects.toThrow('IMAGE_UPLOAD_CAPACITY_BUSY');
  expect(calls).toBe(30);
  expect(time).toBeLessThanOrEqual(60000);
});
