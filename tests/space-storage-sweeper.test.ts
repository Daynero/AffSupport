import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CatalogVideoR2,
  type CatalogVideoR2Config
} from '../supabase/functions/_shared/r2-catalog-video';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import {
  handleSpaceStorageSweeperRequest,
  PURGE_BATCH,
  runSpaceStorageSweeper,
  type SpaceStorageSweeperDeps,
  type SweeperCatalogStore,
  type SweeperSpaceBucket
} from '../supabase/functions/space-storage-sweeper/sweeper';

/**
 * 057 T060: the sweeper of R2 spaces against a fake bucket, a fake zone and a scripted database
 * (the queues themselves are proven in supabase/tests/database/space-storage-purge.test.sql).
 */
const TEAM = '05760000-0000-4000-8000-000000000001';
const GONE_TEAM = '05760000-0000-4000-8000-000000000002';
const id = (n: number) => `05760000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const objectKey = (c: string) => `t/${TEAM}/o/${c.repeat(64)}`;
const videoKey = (n: number) => `v/${String(n).padStart(32, '0')}.mp4`;

/** An in-memory bucket of one space prefix, with failures on demand. */
function fakeBucket(keys: string[] = []) {
  const objects = new Map(keys.map(key => [key, { etag: `"${key.length}"` }]));
  const failing = new Set<string>();
  const removed: string[] = [];
  const aborted: string[] = [];
  const bucket: SweeperSpaceBucket = {
    async remove(key) {
      if (failing.has(key)) throw new TeamFunctionError('STORAGE_UNAVAILABLE', { retryable: true });
      objects.delete(key);
      removed.push(key);
    },
    async head(key) {
      return objects.get(key) ?? null;
    },
    async abortMultipart(key, uploadId) {
      if (failing.has(key)) throw new TeamFunctionError('STORAGE_UNAVAILABLE', { retryable: true });
      aborted.push(`${key}#${uploadId}`);
    },
    async listPrefix(prefix, token, _signal, startAfter) {
      // Like S3, a continuation resumes after a key, so a delete mid-listing shifts nothing.
      const after = token ?? startAfter ?? null;
      const all = [...objects.keys()]
        .filter(key => key.startsWith(prefix) && (!after || key > after))
        .sort();
      const page = all.slice(0, 2);
      return {
        objects: page.map(key => ({
          key,
          bytes: 1,
          etag: objects.get(key)!.etag,
          lastModified: '2026-11-01T00:00:00.000Z'
        })),
        foreignKeys: 0,
        nextToken: all.length > 2 ? page.at(-1)! : null
      };
    }
  };
  return { bucket, objects, failing, removed, aborted };
}

/** A database whose every RPC answers from a script; unscripted queues are empty. */
function scriptedRpc(
  script: Record<string, unknown[] | ((p: Record<string, unknown>) => unknown)>
) {
  const calls: { name: string; parameters: Record<string, unknown> }[] = [];
  const empty: Record<string, unknown> = {
    service_space_catalog_claim_retire: [],
    service_space_catalog_claim_feed_removals: [],
    service_expire_space_trash: 0,
    service_expire_space_uploads: 0,
    service_claim_space_uncertain_uploads: [],
    service_claim_space_object_purges: [],
    service_claim_space_removed_space: null,
    service_claim_space_reconciliation: null,
    service_start_space_reconciliations: 0
  };
  const rpc = vi.fn(async (name: string, parameters: Record<string, unknown>) => {
    calls.push({ name, parameters });
    const entry = script[name];
    if (typeof entry === 'function') return entry(parameters);
    if (Array.isArray(entry)) return entry.length > 0 ? entry.shift() : empty[name];
    return name in empty ? empty[name] : null;
  });
  return { rpc, calls, of: (name: string) => calls.filter(call => call.name === name) };
}

function deps(
  rpc: SpaceStorageSweeperDeps['rpc'],
  extra: Partial<SpaceStorageSweeperDeps> = {}
): SpaceStorageSweeperDeps {
  return {
    rpc,
    space: null,
    catalog: null,
    route: 'sweep',
    worker: 'space-storage-sweeper:test',
    ...extra
  };
}

/** The real catalog adapter over a fake public bucket and zone, so purge bodies are the real ones. */
function catalogStore(options: { purgeOk?: boolean } = {}) {
  const config: CatalogVideoR2Config = {
    accountId: 'a'.repeat(32),
    stagingBucket: 'soty-catalog-videos-dev-staging',
    publicBucket: 'soty-catalog-videos-dev-public',
    publicOrigin: 'https://videos.test',
    zoneId: 'b'.repeat(32),
    purgeToken: 'not-a-real-token',
    partVerification: 'readback'
  };
  const publicKeys = new Set<string>();
  const purges: string[][] = [];
  const order: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.host === 'api.cloudflare.com') {
      const body = (await request.json()) as { files: string[] };
      purges.push(body.files);
      order.push('purge');
      return new Response(JSON.stringify({ success: options.purgeOk !== false }), {
        status: options.purgeOk === false ? 500 : 200
      });
    }
    const key = url.pathname.split('/').slice(2).join('/');
    if (request.method === 'DELETE') {
      publicKeys.delete(key);
      order.push(`delete ${key}`);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'HEAD')
      return new Response(null, { status: publicKeys.has(key) ? 200 : 404 });
    return new Response(null, { status: 400 });
  };
  const signer = { sign: async (request: Request) => request };
  const store: SweeperCatalogStore = new CatalogVideoR2(config, signer, fetcher);
  return { store, publicKeys, purges, order };
}

describe('catalogs of an R2 space (SC-014: their addresses 404 within a minute)', () => {
  it('deletes the copies and the feed, then purges every unique address in one zone call', async () => {
    const catalog = catalogStore();
    for (let n = 1; n <= 10; n += 1) catalog.publicKeys.add(videoKey(n));
    const copies = Array.from({ length: 10 }, (_, i) => ({
      copyId: id(100 + i),
      teamId: TEAM,
      fence: 3,
      objectKey: videoKey(i + 1)
    }));
    // The same copy handed out twice (a retry) is still one address.
    copies.push({ ...copies[0]!, copyId: id(200) });
    const db = scriptedRpc({
      service_space_catalog_claim_retire: [copies],
      service_space_catalog_claim_feed_removals: [[{ feedId: '9'.repeat(32), fence: 1 }]]
    });
    const summary = await runSpaceStorageSweeper(deps(db.rpc, { catalog: catalog.store }));

    expect(catalog.publicKeys.size).toBe(0);
    expect(catalog.purges).toHaveLength(1);
    expect(catalog.purges[0]).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `https://videos.test/${videoKey(i + 1)}`),
      `https://videos.test/feeds/${'9'.repeat(32)}.csv`
    ]);
    // Objects first, purge after: a purge of a live object would be refilled from origin.
    expect(catalog.order.indexOf('purge')).toBeGreaterThan(
      catalog.order.lastIndexOf(`delete ${videoKey(10)}`)
    );
    expect(db.of('service_catalog_video_r2_mark_deleted').map(c => c.parameters.p_success)).toEqual(
      Array(11).fill(true)
    );
    expect(db.of('service_catalog_feed_finish_removal')[0]!.parameters).toMatchObject({
      p_feed_id: '9'.repeat(32),
      p_fence: 1,
      p_success: true
    });
    expect(summary.catalog).toEqual({ copies: 11, feeds: 1, purgedUrls: 11, failed: 0 });
  });

  it('never purges more than thirty addresses a call', async () => {
    const catalog = catalogStore();
    const copies = Array.from({ length: PURGE_BATCH + 5 }, (_, i) => ({
      copyId: id(300 + i),
      teamId: TEAM,
      fence: 1,
      objectKey: videoKey(100 + i)
    }));
    const db = scriptedRpc({
      service_space_catalog_claim_retire: [copies.slice(0, 30), copies.slice(30)]
    });
    await runSpaceStorageSweeper(deps(db.rpc, { catalog: catalog.store }));
    expect(catalog.purges.map(batch => batch.length)).toEqual([30, 5]);
  });

  it('a failed zone purge finishes nothing: the copies are claimed and purged again', async () => {
    const catalog = catalogStore({ purgeOk: false });
    const db = scriptedRpc({
      service_space_catalog_claim_retire: [
        [{ copyId: id(1), teamId: TEAM, fence: 2, objectKey: videoKey(1) }]
      ]
    });
    const summary = await runSpaceStorageSweeper(deps(db.rpc, { catalog: catalog.store }));
    expect(db.of('service_catalog_video_r2_mark_deleted')[0]!.parameters).toMatchObject({
      p_success: false,
      p_code: 'VIDEO_R2_CLEANUP_PARTIAL'
    });
    expect(summary.catalog.failed).toBe(1);
  });

  it('without the catalog store the 050 sweep stays the only one', async () => {
    const db = scriptedRpc({});
    const summary = await runSpaceStorageSweeper(deps(db.rpc));
    expect(db.of('service_space_catalog_claim_retire')).toHaveLength(0);
    expect(summary.skipped).toContain('catalog');
  });
});

describe('the purge queue (FR-048)', () => {
  it('deletes what is due, and a partial failure is reported and retried on the next run', async () => {
    const space = fakeBucket([objectKey('a'), objectKey('b'), objectKey('c')]);
    space.failing.add(objectKey('b'));
    const due = ['a', 'b', 'c'].map((c, i) => ({
      objectId: id(10 + i),
      fence: 1,
      key: objectKey(c)
    }));
    const db = scriptedRpc({ service_claim_space_object_purges: [due] });
    const first = await runSpaceStorageSweeper(deps(db.rpc, { space: space.bucket }));
    expect(first.purged).toBe(2);
    expect(first.purgeFailed).toBe(1);
    expect(
      db
        .of('service_finish_space_object_purge')
        .map(c => `${c.parameters.p_object}:${c.parameters.p_success}:${c.parameters.p_code}`)
        .sort()
    ).toEqual([
      `${id(10)}:true:null`,
      `${id(11)}:false:STORAGE_UNAVAILABLE`,
      `${id(12)}:true:null`
    ]);

    space.failing.clear();
    const retry = scriptedRpc({
      service_claim_space_object_purges: [[{ objectId: id(11), fence: 2, key: objectKey('b') }]]
    });
    const second = await runSpaceStorageSweeper(deps(retry.rpc, { space: space.bucket }));
    expect(second.purged).toBe(1);
    expect(space.objects.size).toBe(0);
  });

  it('runs the database-only steps even before the bucket is configured', async () => {
    const db = scriptedRpc({ service_expire_space_trash: [3], service_expire_space_uploads: [2] });
    const summary = await runSpaceStorageSweeper(deps(db.rpc));
    expect(summary).toMatchObject({
      trashExpired: 3,
      uploadsExpired: 2,
      skipped: ['catalog', 'space']
    });
    expect(db.of('service_claim_space_object_purges')).toHaveLength(0);
  });
});

describe('reservations of uploads past their time (FR-049, lifecycle alignment)', () => {
  it('aborts the multipart and releases; a failed abort waits for the bucket rule', async () => {
    const space = fakeBucket();
    space.failing.add(objectKey('e'));
    const db = scriptedRpc({
      service_claim_space_uncertain_uploads: [
        [
          {
            uploadId: id(20),
            teamId: TEAM,
            key: objectKey('d'),
            r2UploadId: 'mp-1',
            lifecycleAborted: false
          },
          {
            uploadId: id(21),
            teamId: TEAM,
            key: objectKey('e'),
            r2UploadId: 'mp-2',
            lifecycleAborted: false
          },
          {
            uploadId: id(22),
            teamId: TEAM,
            key: objectKey('f'),
            r2UploadId: 'mp-3',
            lifecycleAborted: true
          }
        ]
      ],
      service_settle_space_uncertain_upload: (p: Record<string, unknown>) => p.p_closed === true
    });
    const summary = await runSpaceStorageSweeper(deps(db.rpc, { space: space.bucket }));
    expect(space.aborted).toEqual([`${objectKey('d')}#mp-1`, `${objectKey('f')}#mp-3`]);
    expect(
      db
        .of('service_settle_space_uncertain_upload')
        .map(c => `${c.parameters.p_upload}:${c.parameters.p_closed}`)
    ).toEqual([`${id(20)}:true`, `${id(21)}:false`, `${id(22)}:true`]);
    expect(summary.reservationsReleased).toBe(2);
  });

  it('the sweeper and the bucket agree: a multipart lives one day', () => {
    const lifecycle = JSON.parse(
      readFileSync('config/space-storage/r2-lifecycle.json', 'utf8')
    ) as {
      rules: {
        enabled: boolean;
        conditions: { prefix: string };
        abortMultipartUploadsTransition?: { condition: { maxAge: number } };
      }[];
    };
    const ages = lifecycle.rules
      .filter(rule => rule.enabled && rule.conditions.prefix === '')
      .map(rule => rule.abortMultipartUploadsTransition?.condition.maxAge)
      .filter((age): age is number => typeof age === 'number');
    expect(Math.min(...ages)).toBe(24 * 60 * 60);
    const migration = readFileSync(
      'supabase/migrations/20261226380000_space_storage_sweeper.sql',
      'utf8'
    );
    // Both places the database relies on the rule name the same day.
    expect(migration.match(/expires_at < now\(\) - interval '24 hours'/gu)).toHaveLength(1);
    expect(migration.match(/expires_at >= now\(\) - interval '24 hours'/gu)).toHaveLength(1);
  });
});

describe('a deleted space (SC-016: nothing is left)', () => {
  it('deletes everything under its prefix and closes the tombstone on an empty listing', async () => {
    const keys = [
      `t/${GONE_TEAM}/o/${'1'.repeat(64)}`,
      `t/${GONE_TEAM}/o/${'2'.repeat(64)}`,
      `t/${GONE_TEAM}/d/${'1'.repeat(64)}/1/tile`,
      `t/${GONE_TEAM}/u/${id(30)}/row`,
      objectKey('a')
    ];
    const space = fakeBucket(keys);
    const db = scriptedRpc({
      service_claim_space_removed_space: [{ teamId: GONE_TEAM, fence: 4 }]
    });
    const summary = await runSpaceStorageSweeper(deps(db.rpc, { space: space.bucket }));
    expect([...space.objects.keys()]).toEqual([objectKey('a')]);
    expect(db.of('service_finish_space_removed_space')[0]!.parameters).toEqual({
      p_team: GONE_TEAM,
      p_fence: 4,
      p_deleted: 4,
      p_empty: true,
      p_code: null
    });
    expect(summary.spaces).toEqual({ deletedObjects: 4, emptied: 1, foreignKeys: 0 });
  });

  it('a failure keeps the tombstone open with its code', async () => {
    const key = `t/${GONE_TEAM}/o/${'3'.repeat(64)}`;
    const space = fakeBucket([key]);
    space.failing.add(key);
    const db = scriptedRpc({
      service_claim_space_removed_space: [{ teamId: GONE_TEAM, fence: 1 }]
    });
    await runSpaceStorageSweeper(deps(db.rpc, { space: space.bucket }));
    expect(db.of('service_finish_space_removed_space')[0]!.parameters).toMatchObject({
      p_empty: false,
      p_code: 'STORAGE_UNAVAILABLE'
    });
  });
});

describe('daily reconciliation (FR-049)', () => {
  it('pages the listing in key order, deletes only unchanged orphans past their grace, reports missing', async () => {
    const keys = [objectKey('a'), objectKey('b'), objectKey('c'), objectKey('d'), objectKey('e')];
    const space = fakeBucket(keys);
    const pages: unknown[][] = [];
    const db = scriptedRpc({
      service_start_space_reconciliations: [1],
      service_claim_space_reconciliation: [
        { reconciliationId: id(40), teamId: TEAM, fence: 7, lastKey: null }
      ],
      service_space_reconcile_page: (p: Record<string, unknown>) => {
        pages.push(p.p_objects as unknown[]);
        const listed = p.p_objects as { key: string; etag: string }[];
        // The database decides: 'b' is an orphan past its day; 'd' too, but it changed since.
        const orphans = listed
          .filter(o => o.key === objectKey('b') || o.key === objectKey('d'))
          .map(o => ({ key: o.key, etag: o.key === objectKey('d') ? '"stale"' : o.etag }));
        return { orphans, missing: p.p_final ? 1 : 0, listed: listed.length };
      }
    });
    const summary = await runSpaceStorageSweeper(
      deps(db.rpc, { space: space.bucket, route: 'reconcile' })
    );
    expect(pages.map(page => (page as { key: string }[]).map(o => o.key.at(-1)))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e']
    ]);
    expect((pages[0] as { lastModified: string }[])[0]!.lastModified).toBe(
      '2026-11-01T00:00:00.000Z'
    );
    expect(db.of('service_space_reconcile_page').map(c => c.parameters.p_final)).toEqual([
      false,
      false,
      true
    ]);
    expect(space.removed).toEqual([objectKey('b')]);
    expect(space.objects.has(objectKey('d'))).toBe(true);
    expect(summary.reconciliation).toEqual({
      started: 1,
      pages: 3,
      orphansDeleted: 1,
      missing: 1,
      failed: 0
    });
  });

  it('resumes after the last key it saw', async () => {
    const space = fakeBucket([objectKey('a'), objectKey('b'), objectKey('c')]);
    const db = scriptedRpc({
      service_claim_space_reconciliation: [
        { reconciliationId: id(41), teamId: TEAM, fence: 1, lastKey: objectKey('b') }
      ],
      service_space_reconcile_page: () => ({ orphans: [], missing: 0, listed: 1 })
    });
    await runSpaceStorageSweeper(deps(db.rpc, { space: space.bucket }));
    expect(
      (db.of('service_space_reconcile_page')[0]!.parameters.p_objects as { key: string }[]).map(
        o => o.key
      )
    ).toEqual([objectKey('c')]);
  });

  it('a listing that fails keeps its place and says why', async () => {
    const space = fakeBucket();
    space.bucket.listPrefix = async () => {
      throw new TeamFunctionError('RATE_LIMITED', { retryable: true });
    };
    const db = scriptedRpc({
      service_claim_space_reconciliation: [
        { reconciliationId: id(42), teamId: TEAM, fence: 1, lastKey: null }
      ]
    });
    const summary = await runSpaceStorageSweeper(deps(db.rpc, { space: space.bucket }));
    expect(db.of('service_space_reconcile_failed')[0]!.parameters).toEqual({
      p_reconciliation: id(42),
      p_fence: 1,
      p_code: 'RATE_LIMITED'
    });
    expect(summary.reconciliation.failed).toBe(1);
  });
});

describe('robustness', () => {
  it('one failing step does not stop the others, and the summary carries no keys', async () => {
    const space = fakeBucket([objectKey('a')]);
    const db = scriptedRpc({
      service_expire_space_trash: () => {
        throw new TeamFunctionError('STORAGE_UNAVAILABLE', { retryable: true });
      },
      service_claim_space_object_purges: [[{ objectId: id(1), fence: 1, key: objectKey('a') }]]
    });
    const summary = await runSpaceStorageSweeper(deps(db.rpc, { space: space.bucket }));
    expect(summary.errors).toEqual(['trash:STORAGE_UNAVAILABLE']);
    expect(summary.purged).toBe(1);
    expect(JSON.stringify(summary)).not.toMatch(/t\/|https?:|\.mp4|\.csv/u);
  });

  it('stops claiming when its time is up', async () => {
    let clock = 0;
    const db = scriptedRpc({
      service_claim_space_object_purges: () => {
        clock += 1000;
        return [{ objectId: id(1), fence: 1, key: objectKey('a') }];
      }
    });
    await runSpaceStorageSweeper(
      deps(db.rpc, { space: fakeBucket().bucket, budgetMs: 2500, now: () => clock })
    );
    expect(db.of('service_claim_space_object_purges').length).toBeLessThanOrEqual(3);
  });

  it('answers only a POST with the scheduler secret and a known route', async () => {
    const run = vi.fn(async () => ({ route: 'sweep' }) as never);
    const authorize = vi.fn(async (request: Request) => {
      if (request.headers.get('x-catalog-sync-secret') !== 's')
        throw new TeamFunctionError('AUTH_REQUIRED');
    });
    const post = (body: unknown, secret = 's') =>
      new Request('https://edge.test/functions/v1/space-storage-sweeper', {
        method: 'POST',
        headers: { 'x-catalog-sync-secret': secret },
        body: JSON.stringify(body)
      });
    expect(
      (await handleSpaceStorageSweeperRequest(post({ route: 'sweep' }), { authorize, run })).status
    ).toBe(200);
    expect(
      (await handleSpaceStorageSweeperRequest(post({ route: 'sweep' }, 'x'), { authorize, run }))
        .status
    ).toBe(401);
    expect(
      (await handleSpaceStorageSweeperRequest(post({ route: 'drop' }), { authorize, run })).status
    ).toBe(400);
    expect(
      (
        await handleSpaceStorageSweeperRequest(
          new Request('https://edge.test/functions/v1/space-storage-sweeper'),
          { authorize, run }
        )
      ).status
    ).toBe(400);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
